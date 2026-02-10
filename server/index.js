const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// UPLOADS SETUP
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  res.json({ url: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const pool = new Pool({ connectionString: process.env.POSTGRES_CONNECTION });

// --- VOICE STATE ---
const voiceUsers = {}; 

// --- AUTOMATIC DATABASE INITIALIZATION ---
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        bio TEXT,
        status VARCHAR(20) DEFAULT 'online',
        color VARCHAR(7) DEFAULT '#7289da',
        avatar_url TEXT
      );

      CREATE TABLE IF NOT EXISTS servers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        icon_url TEXT,
        owner_id INT REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        type VARCHAR(20) DEFAULT 'text',
        server_id INT REFERENCES servers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        content TEXT,
        user_id INT REFERENCES users(id),
        channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        server_id INT REFERENCES servers(id) ON DELETE CASCADE,
        name VARCHAR(50),
        color VARCHAR(7) DEFAULT '#99AAB5'
      );

      CREATE TABLE IF NOT EXISTS server_members (
        server_id INT REFERENCES servers(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        role_id INT REFERENCES roles(id) ON DELETE SET NULL,
        PRIMARY KEY (server_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS bans (
        server_id INT REFERENCES servers(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (server_id, user_id)
      );
    `);
    console.log("Database Tables Verified/Created");
    
    // Run Role Fixer after tables exist
    fixRoles();
    
  } catch (err) { console.error("DB Init Error:", err); }
};

// --- SELF-HEALING ROLES ---
const fixRoles = async () => {
  try {
    const servers = await pool.query('SELECT * FROM servers');
    for (const s of servers.rows) {
      const roles = await pool.query('SELECT * FROM roles WHERE server_id = $1', [s.id]);
      let adminRoleId, memberRoleId;
      if (roles.rows.length === 0) {
        const r1 = await pool.query("INSERT INTO roles (server_id, name, color) VALUES ($1, 'Owner', '#F1C40F') RETURNING id", [s.id]);
        adminRoleId = r1.rows[0].id;
        const r2 = await pool.query("INSERT INTO roles (server_id, name, color) VALUES ($1, 'Member', '#99AAB5') RETURNING id", [s.id]);
        memberRoleId = r2.rows[0].id;
      } else {
        adminRoleId = roles.rows.find(r => r.name === 'Owner')?.id || roles.rows[0].id;
        memberRoleId = roles.rows.find(r => r.name === 'Member')?.id || roles.rows[1]?.id || roles.rows[0].id;
      }
      const members = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND role_id IS NULL', [s.id]);
      for (const m of members.rows) {
        const targetRole = (m.user_id === s.owner_id) ? adminRoleId : memberRoleId;
        await pool.query('UPDATE server_members SET role_id = $1 WHERE server_id = $2 AND user_id = $3', [targetRole, s.id, m.user_id]);
      }
    }
  } catch (err) { console.error("Role Fix Error:", err); }
};

// RUN DB INIT
initDB();

io.on('connection', (socket) => {
  console.log('Socket:', socket.id);

  socket.on('login', async (username) => {
    try {
      let res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      if (res.rows.length === 0) {
        try {
          res = await pool.query("INSERT INTO users (username, bio, status, color) VALUES ($1, 'Newbie', 'online', '#7289da') RETURNING *", [username]);
          // Create Default Server on first login ever? Optional. 
          // For now, let's just create the user.
          // await pool.query('INSERT INTO server_members (server_id, user_id) VALUES (1, $1)', [res.rows[0].id]);
        } catch (e) {
          if (e.code === '23505') res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        }
      }
      socket.emit('login_success', res.rows[0]);
    } catch (err) { console.error(err); }
  });

  socket.on('update_profile', async (data) => {
    try {
      const res = await pool.query('UPDATE users SET bio=$1, color=$2, avatar_url=$3 WHERE id=$4 RETURNING *', [data.bio, data.color, data.avatarUrl, data.userId]);
      socket.emit('login_success', res.rows[0]); 
      io.emit('user_updated', res.rows[0]);
    } catch (err) { console.error(err); }
  });

  socket.on('get_servers', async (userId) => {
    try {
      const res = await pool.query(`SELECT s.* FROM servers s JOIN server_members sm ON s.id = sm.server_id WHERE sm.user_id = $1 ORDER BY s.id ASC`, [userId]);
      socket.emit('server_list', res.rows);
    } catch (err) { console.error(err); }
  });

  socket.on('create_server', async (data) => {
    try {
      const sRes = await pool.query('INSERT INTO servers (name, owner_id, icon_url) VALUES ($1, $2, $3) RETURNING *', [data.name, data.userId, data.iconUrl]);
      const newServer = sRes.rows[0];
      const r1 = await pool.query("INSERT INTO roles (server_id, name, color) VALUES ($1, 'Owner', '#F1C40F') RETURNING id", [newServer.id]);
      await pool.query("INSERT INTO roles (server_id, name, color) VALUES ($1, 'Member', '#99AAB5') RETURNING id", [newServer.id]);
      await pool.query('INSERT INTO server_members (server_id, user_id, role_id) VALUES ($1, $2, $3)', [newServer.id, data.userId, r1.rows[0].id]);
      await pool.query("INSERT INTO channels (name, type, server_id) VALUES ('general', 'text', $1)", [newServer.id]);
      socket.emit('server_created', newServer);
    } catch (err) { console.error(err); }
  });

  socket.on('join_server', async ({ inviteCode, userId }) => {
    try {
      const serverRes = await pool.query('SELECT * FROM servers WHERE id = $1', [inviteCode]);
      if (serverRes.rows.length === 0) return;
      const server = serverRes.rows[0];
      const memberCheck = await pool.query('SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2', [server.id, userId]);
      if (memberCheck.rows.length > 0) { socket.emit('server_joined', server); return; }
      const roleRes = await pool.query("SELECT id FROM roles WHERE server_id = $1 AND name = 'Member'", [server.id]);
      const memberRoleId = roleRes.rows[0]?.id;
      await pool.query('INSERT INTO server_members (server_id, user_id, role_id) VALUES ($1, $2, $3)', [server.id, userId, memberRoleId]);
      socket.emit('server_joined', server);
    } catch (err) { console.error(err); }
  });

  socket.on('edit_server', async (data) => {
    try {
      const res = await pool.query('UPDATE servers SET name=$1, icon_url=$2 WHERE id=$3 RETURNING *', [data.name, data.iconUrl, data.serverId]);
      io.emit('server_updated', res.rows[0]);
    } catch (err) { console.error(err); }
  });

  socket.on('delete_server', async (id) => {
    try {
      await pool.query('DELETE FROM servers WHERE id = $1', [id]);
      io.emit('server_deleted', id);
    } catch (err) { console.error(err); }
  });

  socket.on('kick_member', async ({ serverId, targetId, requesterId }) => {
    try {
      const s = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
      if (s.rows.length === 0 || s.rows[0].owner_id !== requesterId) return;
      await pool.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, targetId]);
      io.emit('member_kicked', { serverId, userId: targetId });
    } catch (err) { console.error(err); }
  });

  socket.on('ban_member', async ({ serverId, targetId, requesterId }) => {
    try {
      const s = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
      if (s.rows.length === 0 || s.rows[0].owner_id !== requesterId) return;
      await pool.query('INSERT INTO bans (server_id, user_id) VALUES ($1, $2)', [serverId, targetId]);
      await pool.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, targetId]);
      io.emit('member_banned', { serverId, userId: targetId });
    } catch (err) { console.error(err); }
  });

  socket.on('get_members', async (serverId) => {
    try {
      const query = `
        SELECT u.id, u.username, u.avatar_url, u.status, r.name as role_name, r.color as role_color
        FROM server_members sm
        JOIN users u ON sm.user_id = u.id
        LEFT JOIN roles r ON sm.role_id = r.id
        WHERE sm.server_id = $1
        ORDER BY r.id ASC, u.username ASC
      `;
      const res = await pool.query(query, [serverId]);
      socket.emit('member_list', res.rows);
    } catch (err) { console.error(err); }
  });

  socket.on('get_channels', async (sid) => {
    try {
      const res = await pool.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY id ASC', [sid]);
      socket.emit('channel_list', res.rows);
    } catch (err) { console.error(err); }
  });

  socket.on('create_channel', async (data) => {
    try {
      const type = data.type || 'text';
      const res = await pool.query('INSERT INTO channels (name, type, server_id) VALUES ($1, $2, $3) RETURNING *', [data.name, type, data.serverId]);
      io.emit('channel_created', res.rows[0]);
    } catch (err) { console.error(err); }
  });

  socket.on('delete_channel', async (id) => {
    try {
      await pool.query('DELETE FROM channels WHERE id = $1', [id]);
      io.emit('channel_deleted', id);
    } catch (err) { console.error(err); }
  });

  socket.on('rename_channel', async (d) => {
    try {
      await pool.query('UPDATE channels SET name = $1 WHERE id = $2', [d.name, d.id]);
      io.emit('channel_renamed', d);
    } catch (err) { console.error(err); }
  });

  socket.on('join_channel', async (cid) => {
    socket.join(cid);
    const query = `
      SELECT m.id, m.content, m.created_at, u.username, u.color, u.avatar_url 
      FROM messages m JOIN users u ON m.user_id = u.id 
      WHERE m.channel_id = $1 ORDER BY m.id DESC LIMIT 50
    `;
    const res = await pool.query(query, [cid]);
    socket.emit('history', res.rows.reverse());
  });

  socket.on('send_message', async (d) => {
    try {
      const iRes = await pool.query('INSERT INTO messages(content, user_id, channel_id) VALUES($1, $2, $3) RETURNING *', [d.content, d.userId, d.channelId]);
      const uRes = await pool.query('SELECT username, color, avatar_url FROM users WHERE id = $1', [d.userId]);
      io.to(d.channelId).emit('receive_message', { ...iRes.rows[0], ...uRes.rows[0] });
    } catch (err) { console.error(err); }
  });

  // --- VOICE & WEBRTC SIGNALING ---
  
  socket.on('join_voice', ({ channelId, userId }) => {
    voiceUsers[socket.id] = { channelId, userId };
    const usersInRoom = Object.values(voiceUsers).filter(u => u.channelId === channelId);
    io.emit('voice_status_update', { channelId, users: usersInRoom });
  });

  socket.on('leave_voice', () => {
    const user = voiceUsers[socket.id];
    if (user) {
      delete voiceUsers[socket.id];
      const usersInRoom = Object.values(voiceUsers).filter(u => u.channelId === user.channelId);
      io.emit('voice_status_update', { channelId: user.channelId, users: usersInRoom });
    }
  });

  socket.on('sending_signal', payload => {
    io.to(payload.userToSignal).emit('user_joined_voice', { signal: payload.signal, callerID: payload.callerID });
  });

  socket.on('returning_signal', payload => {
    io.to(payload.callerID).emit('receiving_returned_signal', { signal: payload.signal, id: socket.id });
  });

  socket.on('disconnect', () => {
    const user = voiceUsers[socket.id];
    if (user) {
      delete voiceUsers[socket.id];
      const usersInRoom = Object.values(voiceUsers).filter(u => u.channelId === user.channelId);
      io.emit('voice_status_update', { channelId: user.channelId, users: usersInRoom });
    }
    console.log('Socket Disconnected:', socket.id);
  });
});

server.listen(3000, () => console.log('SERVER RUNNING ON 3000'));