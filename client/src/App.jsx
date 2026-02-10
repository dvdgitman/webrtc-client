import { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io.connect("http://localhost:3000");

function App() {
  const [user, setUser] = useState(null); 
  const [usernameInput, setUsernameInput] = useState("");
  
  // Data
  const [servers, setServers] = useState([]);
  const [activeServer, setActiveServer] = useState(null);
  const [channels, setChannels] = useState([]);
  const [currentChannel, setCurrentChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [inputText, setInputText] = useState("");

  // Voice Data
  const [voiceState, setVoiceState] = useState({}); // { channelId: [users] }
  const [activeVoiceChannel, setActiveVoiceChannel] = useState(null);

  // UI States
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showEditServer, setShowEditServer] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  // Forms
  const [renameInput, setRenameInput] = useState("");
  const [isRenamingChannel, setIsRenamingChannel] = useState(false);
  const [serverName, setServerName] = useState("");
  const [serverIcon, setServerIcon] = useState("");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editAvatar, setEditAvatar] = useState("");

  const chatBottomRef = useRef(null);
  const currentChannelRef = useRef(null);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
      if (window.innerWidth >= 768) setShowMobileMenu(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => { currentChannelRef.current = currentChannel; }, [currentChannel]);

  useEffect(() => {
    const savedUser = localStorage.getItem('chat_username');
    if (savedUser) socket.emit('login', savedUser);

    socket.on('login_success', (u) => {
      setUser(u);
      localStorage.setItem('chat_username', u.username);
      setEditBio(u.bio||""); setEditColor(u.color||"#7289da"); setEditAvatar(u.avatar_url||"");
      socket.emit('get_servers', u.id);
    });

    socket.on('server_list', (list) => {
      setServers(list);
      if (list.length > 0 && !activeServer) selectServer(list[0]);
    });

    socket.on('server_created', (s) => {
      setServers(prev => [...prev, s]);
      selectServer(s);
      setShowCreateServer(false);
    });
    
    socket.on('server_joined', (s) => {
      setServers(prev => { if (prev.find(srv => srv.id === s.id)) return prev; return [...prev, s]; });
      selectServer(s);
      setShowCreateServer(false);
      setInviteCodeInput(""); 
    });

    socket.on('server_updated', (s) => {
      setServers(prev => prev.map(old => old.id === s.id ? s : old));
      if (activeServer?.id === s.id) setActiveServer(s);
    });

    socket.on('server_deleted', (id) => {
      setServers(prev => prev.filter(s => s.id !== id));
      if (activeServer?.id === id) {
        setActiveServer(null); setChannels([]); setCurrentChannel(null); setMembers([]);
        setShowEditServer(false);
      }
    });

    socket.on('member_list', (list) => { setMembers(list); });
    socket.on('member_kicked', ({ serverId, userId }) => {
      if (activeServer?.id === serverId) {
        setMembers(prev => prev.filter(m => m.id !== userId));
        if (user?.id === userId) { alert("You have been kicked!"); window.location.reload(); }
      }
    });
    socket.on('member_banned', ({ serverId, userId }) => {
      if (activeServer?.id === serverId) {
        setMembers(prev => prev.filter(m => m.id !== userId));
        if (user?.id === userId) { alert("You have been BANNED!"); window.location.reload(); }
      }
    });

    socket.on('channel_list', (list) => {
      setChannels(list);
      // Only auto-join text channels
      const textChannel = list.find(c => c.type === 'text');
      if (textChannel) joinChannel(textChannel);
    });

    socket.on('channel_created', (c) => { if (activeServer?.id === c.server_id) setChannels(prev => [...prev, c]); });
    socket.on('channel_deleted', (id) => {
      setChannels(prev => prev.filter(c => c.id !== id));
      if (currentChannelRef.current?.id === id) { setCurrentChannel(null); setMessages([]); }
    });
    socket.on('channel_renamed', (c) => {
      setChannels(prev => prev.map(old => old.id === c.id ? {...old, name: c.name} : old));
      if (currentChannelRef.current?.id === c.id) setCurrentChannel(prev => ({...prev, name: c.name}));
    });

    socket.on('history', (msgs) => { setMessages(msgs); scrollToBottom(); });
    socket.on('receive_message', (msg) => { setMessages(prev => [...prev, msg]); scrollToBottom(); });
    socket.on('user_updated', (u) => {
      setMessages(prev => prev.map(m => m.username === u.username ? {...m, color: u.color, avatar_url: u.avatar_url} : m));
      if (user?.id === u.id) setUser(u);
    });

    // VOICE STATUS
    socket.on('voice_status_update', ({ channelId, users }) => {
      setVoiceState(prev => ({ ...prev, [channelId]: users }));
    });

    return () => socket.off();
  }, [activeServer, user]); 

  const scrollToBottom = () => setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);

  const handleFileUpload = async (e, setUrlCallback) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('http://localhost:3000/upload', { method: 'POST', body: formData });
      const data = await res.json();
      setUrlCallback(data.url); 
    } catch (err) { alert("Upload failed"); }
  };

  const handleChatUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('http://localhost:3000/upload', { method: 'POST', body: formData });
      const data = await res.json();
      socket.emit('send_message', { content: data.url, channelId: currentChannel.id, userId: user.id });
    } catch (err) { alert("Upload failed"); }
  };

  const handleLogin = () => { if (usernameInput) socket.emit('login', usernameInput); };
  const handleLogout = () => {
    localStorage.removeItem('chat_username');
    setUser(null); setActiveServer(null); setMessages([]);
    window.location.reload();
  };

  const selectServer = (s) => {
    setActiveServer(s); setCurrentChannel(null); setMessages([]); setMembers([]);
    socket.emit('get_channels', s.id);
    socket.emit('get_members', s.id); 
  };

  const createServer = () => { socket.emit('create_server', { name: serverName, iconUrl: serverIcon, userId: user.id }); };
  const joinServer = () => { if (inviteCodeInput) socket.emit('join_server', { inviteCode: inviteCodeInput, userId: user.id }); };
  const updateServer = () => { socket.emit('edit_server', { serverId: activeServer.id, name: serverName, iconUrl: serverIcon }); setShowEditServer(false); };
  const deleteServer = () => { if (window.confirm("Delete server?")) socket.emit('delete_server', activeServer.id); };

  const joinChannel = (c) => {
    setCurrentChannel(c); setMessages([]);
    socket.emit('join_channel', c.id);
    if (isMobile) setShowMobileMenu(false);
  };

  // UPDATED CREATE CHANNEL
  const createChannel = () => {
    const name = prompt("Channel Name:");
    if (!name) return;
    const type = window.confirm("Is this a Voice Channel?") ? "voice" : "text";
    socket.emit('create_channel', { name, type, serverId: activeServer.id });
  };

  const joinVoiceChannel = (channel) => {
    if (activeVoiceChannel === channel.id) return;
    setActiveVoiceChannel(channel.id);
    socket.emit('join_voice', { channelId: channel.id, userId: user.id });
  };
  
  const leaveVoice = () => {
    setActiveVoiceChannel(null);
    socket.emit('leave_voice');
  };

  const deleteChannel = (e, id) => { e.stopPropagation(); if (window.confirm("Delete channel?")) socket.emit('delete_channel', id); };
  const renameChannel = () => { if (renameInput) { socket.emit('rename_channel', { id: currentChannel.id, name: renameInput }); setIsRenamingChannel(false); } };
  const sendMessage = () => { if (inputText && currentChannel) { socket.emit('send_message', { content: inputText, channelId: currentChannel.id, userId: user.id }); setInputText(""); } };
  const kickMember = (e, targetId) => { e.stopPropagation(); if(window.confirm("Kick this user?")) socket.emit('kick_member', { serverId: activeServer.id, targetId, requesterId: user.id }); };
  const banMember = (e, targetId) => { e.stopPropagation(); if(window.confirm("BAN this user?")) socket.emit('ban_member', { serverId: activeServer.id, targetId, requesterId: user.id }); };
  const copyInvite = () => { if (activeServer) { navigator.clipboard.writeText(activeServer.id); alert(`Invite Code Copied: ${activeServer.id}`); } };

  const renderIcon = (url, name, size='50px', round=true) => {
    const style = { width: size, height: size, borderRadius: round ? '50%' : '8px', objectFit: 'cover', cursor: 'pointer', background: '#36393f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dcddde', fontWeight: 'bold', fontSize: '12px', overflow: 'hidden', flexShrink: 0 };
    if (url) return <img src={url} style={style} alt="icon" />;
    return <div style={style}>{name?.substring(0, 2).toUpperCase()}</div>;
  };

  // --- RENDER FUNCTIONS ---
  const renderMembersList = () => {
    const isOwner = activeServer?.owner_id === user?.id;
    const grouped = members.reduce((acc, member) => {
      const role = member.role_name || "Member";
      if (!acc[role]) acc[role] = { color: member.role_color, list: [] };
      acc[role].list.push(member);
      return acc;
    }, {});
    const sortedRoles = Object.keys(grouped).sort((a, b) => a === 'Owner' ? -1 : 1);

    return (
      <div style={{width:'240px', background:'#2f3136', display:'flex', flexDirection:'column', padding:'20px 10px', overflowY:'auto', borderLeft:'1px solid #202225', flexShrink: 0}}>
        {sortedRoles.map(role => (
          <div key={role} style={{marginBottom:'20px'}}>
            <div style={{color:'#8e9297', fontSize:'12px', fontWeight:'bold', marginBottom:'10px', textTransform:'uppercase'}}>{role} — {grouped[role].list.length}</div>
            {grouped[role].list.map(m => (
              <div key={m.id} style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'5px', borderRadius:'4px', cursor:'pointer', opacity: m.status === 'offline' ? 0.3 : 1}}>
                <div style={{display:'flex', alignItems:'center'}}>
                  {renderIcon(m.avatar_url, m.username, '32px')}
                  <div style={{marginLeft:'10px', fontWeight:'bold', color: grouped[role].color || '#dcddde'}}>{m.username}</div>
                </div>
                {isOwner && m.id !== user.id && (
                  <div style={{display:'flex', gap:'5px'}}>
                    <span onClick={(e) => kickMember(e, m.id)} title="Kick" style={{fontSize:'12px', opacity:0.6}}>🥾</span>
                    <span onClick={(e) => banMember(e, m.id)} title="Ban" style={{fontSize:'12px', opacity:0.6}}>🔨</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const renderServerRail = () => (
    <div style={{width:'72px', background:'#202225', display:'flex', flexDirection:'column', alignItems:'center', padding:'12px 0', gap:'8px', overflowY:'auto', flexShrink: 0}}>
      {servers.map(srv => (
        <div key={srv.id} onClick={() => selectServer(srv)} style={{border: activeServer?.id === srv.id ? '2px solid white' : 'none', borderRadius: '50%'}}>
          {renderIcon(srv.icon_url, srv.name)}
        </div>
      ))}
      <div onClick={() => { setServerName(""); setServerIcon(""); setInviteCodeInput(""); setShowCreateServer(true); }} style={{width:'50px', height:'50px', borderRadius:'50%', background:'#36393f', color:'#3ba55c', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'30px', cursor:'pointer', transition:'0.2s'}}>+</div>
    </div>
  );

  const renderSidebar = () => (
    <div style={{width:'240px', background:'#2f3136', display:'flex', flexDirection:'column', flexShrink: 0}}>
      {/* HEADER */}
      <div style={{height:'48px', padding:'0 16px', borderBottom:'1px solid #202225', display:'flex', alignItems:'center', justifyContent:'space-between', fontWeight:'bold', boxShadow:'0 1px 0 rgba(0,0,0,0.2)'}}>
        <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'140px'}}>{activeServer?.name || "Server"}</span>
        {activeServer && (
          <div style={{display:'flex'}}>
            <button onClick={copyInvite} title="Invite People" style={{background:'none', border:'none', color:'#b9bbbe', cursor:'pointer', fontSize:'16px', padding:'4px', marginRight:'5px'}}>➕</button>
            <button onClick={() => { setServerName(activeServer.name); setServerIcon(activeServer.icon_url); setShowEditServer(true); }} title="Server Settings" style={{background:'none', border:'none', color:'#b9bbbe', cursor:'pointer', fontSize:'16px', padding:'4px'}}>⚙️</button>
          </div>
        )}
      </div>
      
      {/* CHANNEL LIST */}
      <div style={{flex:1, padding:'10px', overflowY:'auto'}}>
        
        {/* TEXT CHANNELS */}
        <div style={{color:'#8e9297', fontSize:'12px', marginBottom:'5px', fontWeight:'bold'}}>TEXT CHANNELS</div>
        {channels.filter(c => c.type !== 'voice').map(ch => (
          <div key={ch.id} onClick={() => joinChannel(ch)} style={{padding:'6px 8px', borderRadius:'4px', marginBottom:'2px', cursor:'pointer', background: currentChannel?.id === ch.id ? '#393c43' : 'transparent', color: currentChannel?.id === ch.id ? 'white' : '#8e9297', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div style={{display:'flex', alignItems:'center', overflow:'hidden'}}>
              <span style={{marginRight:'5px', opacity:0.6}}>#</span>
              <span style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{ch.name}</span>
            </div>
            {currentChannel?.id === ch.id && <span onClick={(e) => deleteChannel(e, ch.id)} style={{fontSize:'12px', opacity:0.5}}>🗑️</span>}
          </div>
        ))}

        {/* VOICE CHANNELS */}
        <div style={{color:'#8e9297', fontSize:'12px', marginBottom:'5px', marginTop:'20px', fontWeight:'bold', display:'flex', justifyContent:'space-between'}}>
          <span>VOICE CHANNELS</span>
          <span onClick={createChannel} style={{cursor:'pointer', fontSize:'16px'}}>+</span>
        </div>
        {channels.filter(c => c.type === 'voice').map(ch => (
          <div key={ch.id} style={{marginBottom:'5px'}}>
            <div onClick={() => joinVoiceChannel(ch)} style={{padding:'6px 8px', borderRadius:'4px', cursor:'pointer', color: '#8e9297', display:'flex', alignItems:'center', background: activeVoiceChannel === ch.id ? 'rgba(255,255,255,0.05)' : 'transparent'}}>
              <span style={{marginRight:'5px', opacity:0.6}}>🔊</span>
              <span>{ch.name}</span>
            </div>
            {/* RENDER USERS INSIDE VOICE */}
            <div style={{paddingLeft:'20px'}}>
              {voiceState[ch.id]?.map(u => {
                const memberDetails = members.find(m => m.id === u.userId);
                return (
                  <div key={u.userId} style={{display:'flex', alignItems:'center', marginTop:'4px'}}>
                    {renderIcon(memberDetails?.avatar_url, memberDetails?.username || "?", "20px")}
                    <span style={{fontSize:'12px', color:'#b9bbbe', marginLeft:'5px'}}>{memberDetails?.username || "Unknown"}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}

      </div>

      {/* VOICE CONTROLS */}
      {activeVoiceChannel && (
        <div style={{background:'#202225', padding:'8px', borderBottom:'1px solid #2f3136'}}>
          <div style={{color:'#3ba55c', fontSize:'12px', fontWeight:'bold', marginBottom:'4px'}}>Voice Connected</div>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <span style={{fontSize:'12px', color:'#b9bbbe'}}>General / Voice</span>
            <button onClick={leaveVoice} style={{background:'none', border:'none', fontSize:'16px', cursor:'pointer'}}>☎️</button>
          </div>
        </div>
      )}

      {/* USER BAR */}
      <div style={{background:'#292b2f', padding:'8px', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <div style={{display:'flex', alignItems:'center', cursor:'pointer', flex:1, overflow:'hidden', marginRight:'5px'}} onClick={() => setShowProfileModal(true)}>
          {renderIcon(user.avatar_url, user.username, '32px')}
          <div style={{marginLeft:'8px', overflow:'hidden', display:'flex', flexDirection:'column'}}>
              <div style={{fontSize:'13px', fontWeight:'bold', whiteSpace:'nowrap', textOverflow:'ellipsis'}}>{user.username}</div>
              <div style={{fontSize:'10px', color:'#b9bbbe', whiteSpace:'nowrap', textOverflow:'ellipsis'}}>{user.bio || "Online"}</div>
          </div>
        </div>
        <div style={{display:'flex'}}>
          <button onClick={() => setShowProfileModal(true)} className="icon-btn" title="Edit Profile" style={{background:'none', border:'none', color:'#b9bbbe', cursor:'pointer', fontSize:'16px', padding:'5px'}}>⚙️</button>
          <button onClick={handleLogout} className="icon-btn" title="Log Out" style={{background:'none', border:'none', color:'#b9bbbe', cursor:'pointer', fontSize:'16px', padding:'5px'}}>⎋</button>
        </div>
      </div>
    </div>
  );

  if (!user) return (
    <div style={{height:'100vh', display:'flex', justifyContent:'center', alignItems:'center', background:'#2f3136'}}>
      <div style={{padding:'40px', background:'#36393f', borderRadius:'8px', textAlign:'center', maxWidth:'90%'}}>
        <h2 style={{color:'white'}}>Discord Clone</h2>
        <input value={usernameInput} onChange={e=>setUsernameInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleLogin()} placeholder="Username" style={{padding:'10px', borderRadius:'4px', border:'none', width:'100%'}}/>
        <button onClick={handleLogin} style={{marginTop:'10px', width:'100%', padding:'10px', background:'#7289da', border:'none', color:'white', borderRadius:'4px', cursor:'pointer'}}>Enter</button>
      </div>
    </div>
  );

  return (
    <div style={{display:'flex', height:'100vh', fontFamily:'sans-serif', color:'white', background:'#36393f', overflow:'hidden'}}>
      {isMobile && showMobileMenu && (
        <div className="mobile-sidebar-overlay" onClick={() => setShowMobileMenu(false)}>
          <div className="sidebar-container" onClick={e => e.stopPropagation()}>
            {renderServerRail()}
            {renderSidebar()}
          </div>
        </div>
      )}
      {!isMobile && (
        <>
          {renderServerRail()}
          {renderSidebar()}
        </>
      )}

      <div style={{flex:1, display:'flex', flexDirection:'column', background:'#36393f', minWidth:0}}>
        <div style={{height:'48px', padding:'0 16px', borderBottom:'1px solid #26272d', display:'flex', alignItems:'center', background:'#36393f', flexShrink:0, justifyContent: 'space-between'}}>
          <div style={{display:'flex', alignItems:'center'}}>
            {isMobile && <button onClick={() => setShowMobileMenu(true)} style={{background:'none', border:'none', color:'white', fontSize:'20px', marginRight:'15px', cursor:'pointer'}}>☰</button>}
            {currentChannel ? (
              isRenamingChannel ? (
                <>
                  <input value={renameInput} onChange={e=>setRenameInput(e.target.value)} style={{background:'#202225', color:'white', border:'none', padding:'5px'}} />
                  <button onClick={renameChannel} style={{marginLeft:'5px'}}>Save</button>
                </>
              ) : (
                <div style={{display:'flex', alignItems:'center', overflow:'hidden'}}>
                  <span style={{fontSize:'20px', fontWeight:'bold', marginRight:'10px', whiteSpace:'nowrap'}}># {currentChannel.name}</span>
                  <span onClick={() => { setIsRenamingChannel(true); setRenameInput(currentChannel.name); }} style={{fontSize:'12px', color:'#7289da', cursor:'pointer'}}>Edit</span>
                </div>
              )
            ) : <div>Select a channel</div>}
          </div>
        </div>

        <div style={{flex:1, overflowY:'auto', padding:'20px'}}>
          {messages.map((msg, i) => (
            <div key={i} style={{display:'flex', marginBottom:'15px'}}>
              {renderIcon(msg.avatar_url, msg.username, '40px')}
              <div style={{marginLeft:'15px', minWidth:0}}>
                <div style={{display:'flex', alignItems:'baseline'}}>
                  <span style={{fontWeight:'bold', color: msg.color||'white', marginRight:'8px'}}>{msg.username}</span>
                  <span style={{fontSize:'12px', color:'#72767d'}}>{new Date(msg.created_at).toLocaleTimeString()}</span>
                </div>
                {msg.content.includes('/uploads/') && (msg.content.endsWith('.png') || msg.content.endsWith('.jpg') || msg.content.endsWith('.gif')) ? (
                  <img src={msg.content} style={{maxWidth:'100%', borderRadius:'8px', maxHeight:'300px', objectFit:'contain'}} alt="upload" />
                ) : (
                  <div style={{color:'#dcddde', wordWrap:'break-word'}}>{msg.content}</div>
                )}
              </div>
            </div>
          ))}
          <div ref={chatBottomRef} />
        </div>

        <div style={{padding:'20px'}}>
          <div style={{background:'#40444b', borderRadius:'8px', display:'flex', alignItems:'center', padding:'0 10px'}}>
            <label style={{cursor:'pointer', marginRight:'10px', display:'flex', alignItems:'center', justifyContent:'center', height:'24px', width:'24px', borderRadius:'50%', background:'#b9bbbe', color:'#36393f', fontSize:'18px', fontWeight:'bold'}}>
              + <input type="file" onChange={handleChatUpload} style={{display:'none'}} />
            </label>
            <input value={inputText} onChange={e=>setInputText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendMessage()} placeholder={`Message #${currentChannel?.name || "..."}`} style={{flex:1, padding:'12px 0', background:'transparent', border:'none', color:'white', boxSizing:'border-box', outline:'none'}} />
          </div>
        </div>
      </div>

      {!isMobile && renderMembersList()}

      {/* MODALS */}
      {showCreateServer && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000}}>
          <div style={{background:'#36393f', padding:'20px', borderRadius:'8px', width:'300px', maxWidth:'90%'}}>
            <h3 style={{textAlign:'center', marginBottom:'20px'}}>Create My Own</h3>
            <input value={serverName} onChange={e=>setServerName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&createServer()} placeholder="Server Name" style={{width:'100%', padding:'10px', marginBottom:'10px', boxSizing:'border-box'}} />
            <div style={{marginBottom:'10px'}}>
              <label style={{fontSize:'12px', color:'#b9bbbe'}}>Icon (Optional)</label>
              <input type="file" onChange={(e) => handleFileUpload(e, setServerIcon)} style={{marginTop:'5px', color:'white', maxWidth:'100%'}} />
            </div>
            {serverIcon && <img src={serverIcon} style={{width:'50px', height:'50px', borderRadius:'50%', margin:'0 auto', display:'block'}} alt="preview" />}
            <button onClick={createServer} style={{width:'100%', padding:'10px', background:'#5865F2', color:'white', border:'none', cursor:'pointer', marginTop:'10px', borderRadius:'4px'}}>Create</button>
            <div style={{margin:'20px 0', borderTop:'1px solid #4f545c', position:'relative', textAlign:'center'}}>
              <span style={{background:'#36393f', padding:'0 10px', position:'absolute', top:'-10px', left:'50%', transform:'translateX(-50%)', color:'#b9bbbe', fontSize:'12px'}}>OR</span>
            </div>
            <h3 style={{textAlign:'center', marginBottom:'10px'}}>Join a Server</h3>
            <div style={{marginBottom:'10px'}}>
              <label style={{fontSize:'12px', color:'#b9bbbe', fontWeight:'bold', display:'block', marginBottom:'5px'}}>INVITE CODE</label>
              <input value={inviteCodeInput} onChange={e=>setInviteCodeInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&joinServer()} placeholder="e.g. 7" style={{width:'100%', padding:'10px', boxSizing:'border-box'}} />
            </div>
            <button onClick={joinServer} style={{width:'100%', padding:'10px', background:'#3ba55c', color:'white', border:'none', cursor:'pointer', borderRadius:'4px'}}>Join Server</button>
            <button onClick={()=>setShowCreateServer(false)} style={{marginTop:'15px', background:'none', border:'none', color:'#b9bbbe', cursor:'pointer', width:'100%', fontSize:'12px'}}>Cancel</button>
          </div>
        </div>
      )}
      {showEditServer && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000}}>
          <div style={{background:'#36393f', padding:'20px', borderRadius:'8px', width:'300px', maxWidth:'90%'}}>
            <h3>Server Settings</h3>
            <input value={serverName} onChange={e=>setServerName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&updateServer()} style={{width:'100%', padding:'10px', marginBottom:'10px', boxSizing:'border-box'}} />
            <input type="file" onChange={(e) => handleFileUpload(e, setServerIcon)} style={{marginBottom:'10px', color:'white', maxWidth:'100%'}} />
            {serverIcon && <img src={serverIcon} style={{width:'50px', height:'50px', borderRadius:'50%', display:'block', marginBottom:'10px'}} alt="preview" />}
            <button onClick={updateServer} style={{width:'100%', padding:'10px', background:'#7289da', color:'white', border:'none', cursor:'pointer'}}>Save Changes</button>
            <div style={{borderTop:'1px solid #444', margin:'15px 0'}}></div>
            <button onClick={deleteServer} style={{width:'100%', padding:'10px', background:'#ed4245', color:'white', border:'none', cursor:'pointer'}}>DELETE SERVER</button>
            <button onClick={()=>setShowEditServer(false)} style={{marginTop:'10px', background:'none', border:'none', color:'white', cursor:'pointer', width:'100%'}}>Cancel</button>
          </div>
        </div>
      )}
      {showProfileModal && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000}}>
          <div style={{background:'#36393f', padding:'20px', borderRadius:'8px', width:'300px', maxWidth:'90%'}}>
            <h3>Edit Profile</h3>
            <input value={editBio} onChange={e=>setEditBio(e.target.value)} placeholder="Bio" style={{width:'100%', padding:'8px', marginBottom:'10px', boxSizing:'border-box'}} />
            <input type="file" onChange={(e) => handleFileUpload(e, setEditAvatar)} style={{marginBottom:'10px', color:'white', maxWidth:'100%'}} />
            {editAvatar && <img src={editAvatar} style={{width:'50px', height:'50px', borderRadius:'50%', display:'block', marginBottom:'10px'}} alt="preview" />}
            <input type="color" value={editColor} onChange={e=>setEditColor(e.target.value)} style={{width:'100%', height:'40px', marginBottom:'10px'}} />
            <button onClick={() => { socket.emit('update_profile', { userId: user.id, bio: editBio, color: editColor, avatarUrl: editAvatar }); setShowProfileModal(false); }} style={{width:'100%', padding:'10px', background:'#7289da', color:'white', border:'none'}}>Save</button>
            <button onClick={()=>setShowProfileModal(false)} style={{marginTop:'10px', background:'none', border:'none', color:'white'}}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;