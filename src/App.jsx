import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  SUPA_URL, SUPA_ANON, SB_KEY,
  sbHeaders, getToken, saveSession, sbFrom, sbRpc,
  Auth, authListeners,
  idbOpen, idbGetChapterLocal, idbPutVerses, idbGetStrongsEntryLocal,
  idbSearchStrongsLocal, idbPutStrongsEntries, idbClearStrongs,
  idbSearchWebsterLocal, idbPutWebsterEntries, idbClearWebster,
  idbGetMeta, idbPutMeta, idbIsDownloaded, idbDeleteVersionLocal,
  downloadVersionLocally, downloadStrongsLocally, downloadWebsterLocally,
  BIBLE, WOJ, WOJ_RAW, isWOJ, ABBREVS,
  ISSUE_TYPES, STATUS_VALUES, STATUS_LABELS, ISSUE_LABELS, PUBLIC_VERSIONS,
  D, L, BD, BL, stSt, ACCENTS, FS, FB, fontFamilyMap,
  genId, clone, fmtDate, esc, normRef, parseRef, parseRefDD, hl,
  processRedLetter, buildStrongsVerse,
  dbGetChapter, dbGetStrongsForChapter, dbGetStrongsEntry, dbSearchStrongs,
  dbGetStrongsVerses, dbGetVerse, dbAutoFill,
  dbLoadOrCreateProject, dbLoadProject, dbSaveEntry, dbDeleteEntry,
  dbSaveSection, dbDeleteSection, dbSaveVersions,
  dbLoadBookmarks, dbAddBookmark, dbDeleteBookmark,
  dbLoadRecents, dbRecordRecent,
} from './lib.js';

// ══════════════════════════════════════════════════════════
//  UI ATOMS
// ══════════════════════════════════════════════════════════
function Lbl({c,req,T}){return <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:500}}>{c}{req&&<span style={{color:'#d46868',marginLeft:4}}>*</span>}</div>;}
function OrnRule({T}){return(<div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><div style={{flex:1,height:1,background:T.accentLine}}/><span style={{color:T.gD,fontSize:8,lineHeight:1}}>✦</span><div style={{flex:1,height:1,background:T.accentLine}}/></div>);}
function Inp({val,set,ph,T,type}){return <input className="s-btn" type={type||'text'} value={val} onChange={e=>set(e.target.value)} placeholder={ph||''} style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 13px',outline:'none'}}/>;}
function Sel({val,set,children,T,sm,dis}){return <select className="s-btn" value={val} onChange={e=>set(e.target.value)} disabled={dis} style={{width:sm?'auto':'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:val?T.mut:T.dim,fontFamily:FB,fontSize:sm?14:16,padding:sm?'5px 10px':'9px 13px',cursor:'pointer',opacity:dis?.4:1,outline:'none'}}>{children}</select>;}
function TA({val,set,ph,T,rows}){return <textarea className="s-btn" value={val} onChange={e=>set(e.target.value)} placeholder={ph||''} rows={rows||3} style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 13px',resize:'vertical',lineHeight:1.7,outline:'none'}}/>;}
function GhostBtn({ch,onClick,active,T,title}){return <button className="s-btn s-ghost" onClick={onClick} title={title} style={{background:active?T.gF:'transparent',border:`1px solid ${active?T.gD:'transparent'}`,borderRadius:6,color:active?T.gT:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'5px 11px',whiteSpace:'nowrap',fontWeight:active?600:400,cursor:'pointer',transition:'all .15s'}}>{ch}</button>;}
function TBtn({ch,onClick,active,primary,T}){const p=primary||active;return <button className="s-btn s-tbtn" onClick={onClick} style={{background:p?T.gF:'transparent',border:`1px solid ${p?T.gD:T.bd}`,borderRadius:6,color:p?T.gT:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:'7px 14px',whiteSpace:'nowrap',fontWeight:500}}>{ch}</button>;}
function IBtn({ch,onClick,danger,T,title}){return <button className={`s-btn${danger?' s-danger':' s-ghost'}`} onClick={onClick} title={title} style={{background:danger?T.red:'transparent',border:`1px solid ${danger?T.redTxt+'33':T.bd+'40'}`,borderRadius:5,color:danger?T.redTxt:T.dim,padding:'4px 9px',fontSize:13,fontFamily:FB,lineHeight:1,fontWeight:500}}>{ch}</button>;}
function PBtn({ch,onClick,T,sm,danger,disabled}){const bg=danger?T.red:T.gF;const bc=danger?T.redTxt+'55':T.gD;const tc=danger?T.redTxt:T.gT;return <button className="s-btn" onClick={onClick} disabled={disabled} style={{background:bg,border:`1px solid ${bc}`,borderRadius:6,color:tc,fontFamily:FS,fontSize:sm?9:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:sm?'6px 13px':'8px 18px',whiteSpace:'nowrap',fontWeight:600,opacity:disabled?.45:1,cursor:disabled?'default':'pointer'}}>{ch}</button>;}
function SBtn({ch,onClick,T}){return <button className="s-btn s-ghost" onClick={onClick} style={{background:'transparent',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:'8px 18px',whiteSpace:'nowrap',fontWeight:500}}>{ch}</button>;}
function Badge({type,label,dark}){const bc=(dark?BD:BL)[type]||(dark?BD.other:BL.other);return <span style={{fontFamily:FS,fontSize:8.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:'3px 9px',borderRadius:4,border:`1px solid ${bc.bd}`,background:bc.bg,color:bc.txt,whiteSpace:'nowrap',flexShrink:0,fontWeight:500}}>{label}</span>;}
function Spinner(){return <span className="spinner"/>;}

function Modal({title,onClose,children,footer,wide,T}){
  return(
    <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,zIndex:200,background:'rgba(0,0,0,0.72)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,backdropFilter:'blur(4px)'}}>
      <div className="modal-in modal-panel" style={{background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:14,width:`min(95vw,${wide?840:700}px)`,maxHeight:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.65)'}}>
        <div style={{height:3,background:T.accentLine}}/>
        <div style={{background:T.bgCH,borderBottom:`1px solid ${T.bdA}`,padding:'16px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <span style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.06em'}}>{title}</span>
          <button className="s-btn s-ghost" onClick={onClose} style={{background:'none',border:'none',color:T.dim,fontSize:16,padding:'2px 8px'}}>✕</button>
        </div>
        <div className="modal-body" style={{overflowY:'auto',flex:1,padding:'22px 24px'}}>{children}</div>
        {footer&&<div style={{borderTop:`1px solid ${T.bd}`,padding:'12px 20px',display:'flex',justifyContent:'flex-end',gap:10,background:T.bgCH,flexShrink:0}}>{footer}</div>}
      </div>
    </div>
  );
}

function ConfirmDialog({title,message,confirmLabel,cancelLabel,onConfirm,onCancel,danger,T,children}){
  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onCancel();}} style={{position:'fixed',inset:0,zIndex:500,background:'rgba(0,0,0,0.78)',display:'flex',alignItems:'center',justifyContent:'center',padding:24,backdropFilter:'blur(5px)'}}>
      <div className="modal-in" style={{background:danger?'#180606':T.bgCard,border:`2px solid ${danger?'#8a2020':T.bdA}`,borderRadius:14,width:'min(92vw,480px)',overflow:'hidden',boxShadow:danger?'0 32px 80px rgba(140,10,10,0.4)':'0 32px 80px rgba(0,0,0,0.7)'}}>
        <div style={{height:3,background:danger?'linear-gradient(90deg,#5a1010,#c83030,#5a1010)':T.accentLine}}/>
        <div style={{padding:'22px 26px 16px'}}>
          <div style={{fontFamily:FS,fontSize:14,fontWeight:600,letterSpacing:'0.06em',color:danger?'#f08080':T.gT,marginBottom:12}}>{title}</div>
          <div style={{fontFamily:FB,fontSize:17,color:danger?'#c09090':T.mut,lineHeight:1.7}}>{message}</div>
          {children}
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'16px 26px',background:'rgba(0,0,0,0.2)',borderTop:`1px solid ${danger?'#4a1212':T.bdA}`}}>
          <SBtn ch={cancelLabel||'Cancel'} onClick={onCancel} T={T}/>
          {confirmLabel&&<PBtn ch={confirmLabel} onClick={onConfirm} T={T} danger={danger}/>}
        </div>
      </div>
    </div>
  );
}

function Legend({T,refLabel}){
  const items=[{bg:T.blue,bd:T.blueTxt,l:`Reference (${refLabel||'Ref'})`},{bg:T.green,bd:T.greenTxt,l:'Faithful to TR'},{bg:T.red,bd:T.redTxt,l:'Corrupt (Alex.)'},{bg:T.dif,bd:T.difTxt,l:'Differs'},{bg:T.ora,bd:T.oraTxt,l:'Partial'},{bg:T.pur,bd:T.purTxt,l:'Absent'}];
  return(<div className="no-print" style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',padding:'7px 24px',background:T.bg2,borderBottom:`1px solid ${T.bdS}`,position:'relative'}}>
    <div className="gold-shimmer" style={{position:'absolute',bottom:0,left:0,right:0,height:1}}/>
    {items.map(({bg,bd,l})=>(<div key={l} style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:10,height:10,borderRadius:3,background:bg,border:`1px solid ${bd}40`,flexShrink:0}}/><span style={{fontFamily:FS,fontSize:8.5,color:T.dim,letterSpacing:'0.08em',fontWeight:500}}>{l}</span></div>))}
  </div>);
}

function RefDD({bkN,setBkN,ch,setCh,vs,setVs,T,err}){
  const bk=BIBLE.find(b=>b.n===bkN)||null;const chC=bk?bk.v.length:0;const vsC=(bk&&ch)?bk.v[ch-1]||0:0;
  const s=(a)=>({background:T.bgIn,border:`1px solid ${err?'#8a2020':T.bd}`,borderRadius:6,color:a?T.mut:T.dim,fontFamily:FB,fontSize:14,padding:'7px 8px',opacity:a?1:.5,outline:'none'});
  return(<div style={{display:'flex',gap:6}}>
    <select className="s-btn" value={bkN||''} onChange={e=>{setBkN(parseInt(e.target.value)||0);setCh(0);setVs(0);}} style={{...s(true),flex:1,minWidth:0}}><option value="">— Book —</option>{BIBLE.map(b=><option key={b.n} value={b.n}>{b.name}</option>)}</select>
    <select className="s-btn" value={ch||''} disabled={!bkN} onChange={e=>{setCh(parseInt(e.target.value)||0);setVs(0);}} style={{...s(!!bkN),width:62}}><option value="">Ch</option>{Array.from({length:chC},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select>
    <select className="s-btn" value={vs||''} disabled={!ch} onChange={e=>setVs(parseInt(e.target.value)||0)} style={{...s(!!ch),width:62}}><option value="">Vs</option>{Array.from({length:vsC},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select>
  </div>);
}


// ══════════════════════════════════════════════════════════
//  AUTH PANEL
// ══════════════════════════════════════════════════════════
function RecoveryPanel({T,onDone}){
  const[pw,setPw]=useState('');const[pw2,setPw2]=useState('');
  const[showPw,setShowPw]=useState(false);
  const[err,setErr]=useState('');const[msg,setMsg]=useState('');const[busy,setBusy]=useState(false);
  const pwInputStyle={width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 42px 9px 13px',outline:'none',boxSizing:'border-box'};
  const eyeStyle={position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:T.gM,cursor:'pointer',fontSize:15,padding:4,lineHeight:1};
  async function doUpdate(){
    if(!pw){setErr('Please enter a new password.');return;}
    if(pw!==pw2){setErr('Passwords do not match.');return;}
    if(pw.length<6){setErr('Password must be at least 6 characters.');return;}
    setBusy(true);setErr('');
    try{
      const r=await Auth.updatePassword(pw);
      if(r.error){setErr(r.error);setBusy(false);return;}
      setMsg('Password updated! You can now use Scriptorium.');
      setTimeout(onDone,2000);
    }catch(ex){setErr('Network error — check your connection.');}
    setBusy(false);
  }
  return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:T.bg,padding:24}}>
      
      <div className="fade-up" style={{textAlign:'center',marginBottom:32}}>
        <div style={{fontFamily:FS,fontSize:26,fontWeight:700,color:T.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
        <div style={{fontFamily:FB,fontStyle:'italic',color:T.gM,fontSize:14,lineHeight:1.7}}>"The words of the LORD are pure words" — Psalm 12:6</div>
      </div>
      <div className="modal-in fade-up stagger-1" style={{background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.6)'}}>
        <div style={{height:3,background:T.accentLine}}/>
        <div style={{padding:'28px 32px'}}>
          <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:6,textAlign:'center'}}>Set New Password</div>
          <div style={{fontFamily:FB,fontSize:13,color:T.mut,textAlign:'center',marginBottom:22,lineHeight:1.6}}>Choose a new password for your account.</div>
          {msg&&<div style={{marginBottom:16,padding:'10px 14px',background:T.green,border:`1px solid ${T.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:T.greenTxt,lineHeight:1.6}}>{msg}</div>}
          {err&&<div style={{marginBottom:16,padding:'10px 14px',background:T.red,border:`1px solid ${T.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:T.redTxt}}>{err}</div>}
          {!msg&&<>
            <div style={{marginBottom:14}}>
              <Lbl c="New Password" T={T}/>
              <div style={{position:'relative'}}>
                <input className="s-btn" type={showPw?'text':'password'} value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" style={pwInputStyle}/>
                <button type="button" onClick={()=>setShowPw(v=>!v)} style={eyeStyle}>{showPw?'🙈':'👁'}</button>
              </div>
            </div>
            <div style={{marginBottom:22}}>
              <Lbl c="Confirm Password" T={T}/>
              <div style={{position:'relative'}}>
                <input className="s-btn" type={showPw?'text':'password'} value={pw2} onChange={e=>setPw2(e.target.value)} onKeyDown={e=>e.key==='Enter'&&doUpdate()} placeholder="••••••••" style={pwInputStyle}/>
              </div>
            </div>
            <button type="button" onClick={doUpdate} disabled={busy} style={{width:'100%',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?.6:1}}>{busy?'…':'Update Password'}</button>
          </>}
        </div>
      </div>
    </div>
  );
}

function AuthPanel({onAuth}){
  const[email,setEmail]=useState('');const[pw,setPw]=useState('');
  const[showPw,setShowPw]=useState(false);
  const[err,setErr]=useState('');const[msg,setMsg]=useState('');const[busy,setBusy]=useState(false);
  const[showSignup,setShowSignup]=useState(false);
  const[showForgot,setShowForgot]=useState(false);
  const[showGuestWarning,setShowGuestWarning]=useState(false);
  const[forgotEmail,setForgotEmail]=useState('');
  const[forgotMsg,setForgotMsg]=useState('');const[forgotErr,setForgotErr]=useState('');const[forgotBusy,setForgotBusy]=useState(false);
  // Signup modal state
  const[suEmail,setSuEmail]=useState('');const[suPw,setSuPw]=useState('');
  const[showSuPw,setShowSuPw]=useState(false);
  const[suErr,setSuErr]=useState('');const[suMsg,setSuMsg]=useState('');const[suBusy,setSuBusy]=useState(false);

  const pwInputStyle={width:'100%',background:D.bgIn,border:`1px solid ${D.bd}`,borderRadius:6,color:D.body,fontFamily:FB,fontSize:16,padding:'9px 42px 9px 13px',outline:'none',boxSizing:'border-box'};
  const eyeStyle={position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:D.gM,cursor:'pointer',fontSize:15,padding:4,lineHeight:1};

  async function doSignIn(){
    if(!email.trim()||!pw){setErr('Email and password required.');return;}
    setBusy(true);setErr('');
    try{
      const r=await Auth.signIn(email.trim(),pw);
      if(r.error){setErr(String(r.error));setBusy(false);return;}
      onAuth(r.user);
    }catch(ex){setErr('Network error — check your connection. ('+String(ex.message||ex)+')');}
    setBusy(false);
  }

  async function doSignUp(){
    if(!suEmail.trim()||!suPw){setSuErr('Email and password required.');return;}
    setSuBusy(true);setSuErr('');
    try{
      const r=await Auth.signUp(suEmail.trim(),suPw);
      if(r.error){setSuErr(String(r.error));setSuBusy(false);return;}
      if(r.needsConfirm){setSuMsg('Check your email to confirm your account, then sign in.');setSuBusy(false);return;}
      onAuth(r.user);
    }catch(ex){setSuErr('Network error — check your connection. ('+String(ex.message||ex)+')');}
    setSuBusy(false);
  }

  function closeSignup(){setShowSignup(false);setSuEmail('');setSuPw('');setSuErr('');setSuMsg('');setShowSuPw(false);}
  function closeForgot(){setShowForgot(false);setForgotEmail('');setForgotMsg('');setForgotErr('');setForgotBusy(false);}
  async function doForgotPassword(){
    if(!forgotEmail.trim()){setForgotErr('Please enter your email.');return;}
    setForgotBusy(true);setForgotErr('');
    try{
      const r=await Auth.resetPassword(forgotEmail.trim());
      if(r.error){setForgotErr(r.error);setForgotBusy(false);return;}
      setForgotMsg('Check your email for a password reset link.');
    }catch(ex){setForgotErr('Network error — check your connection.');}
    setForgotBusy(false);
  }

  return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg,padding:24}}>
      
      <div className="fade-up" style={{textAlign:'center',marginBottom:32}}>
        <div style={{fontFamily:FS,fontSize:11,letterSpacing:'0.3em',textTransform:'uppercase',color:D.gD,marginBottom:10,fontWeight:500}}>{PUBLIC_VERSIONS.map(v=>v.label).join(' / ')}</div>
        <div style={{fontFamily:FS,fontSize:26,fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
        <div style={{fontFamily:FB,fontStyle:'italic',color:D.gM,fontSize:14,lineHeight:1.7}}>"The words of the LORD are pure words" — Psalm 12:6</div>
      </div>

      {/* Login card */}
      <div className="modal-in fade-up stagger-1" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.6)'}}>
        <div style={{height:3,background:D.accentLine}}/>
        <div style={{padding:'28px 32px'}}>
          <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:D.gT,letterSpacing:'0.08em',marginBottom:22,textAlign:'center'}}>Sign In</div>
          {msg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.greenTxt,lineHeight:1.6}}>{msg}</div>}
          {err&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.redTxt,wordBreak:'break-word'}}>{err}</div>}
          <div style={{marginBottom:14}}><Lbl c="Email" T={D}/><Inp val={email} set={setEmail} ph="you@example.com" T={D} type="email"/></div>
          <div style={{marginBottom:22}}>
            <Lbl c="Password" T={D}/>
            <div style={{position:'relative'}}>
              <input className="s-btn" type={showPw?'text':'password'} value={pw} onChange={e=>setPw(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&doSignIn()} placeholder="••••••••" style={pwInputStyle}/>
              <button type="button" onClick={()=>setShowPw(v=>!v)} style={eyeStyle} title={showPw?'Hide password':'Show password'}>{showPw?'🙈':'👁'}</button>
            </div>
          </div>
          <button type="button" onClick={doSignIn} disabled={busy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?.6:1}}>{busy?'…':'Sign In'}</button>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:18}}>
            <button type="button" onClick={()=>{setShowForgot(true);setForgotEmail(email);}} style={{background:'none',border:'none',color:D.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',cursor:'pointer',fontWeight:400,textDecoration:'underline',padding:0}}>Forgot password?</button>
            <button type="button" onClick={()=>setShowSignup(true)} style={{background:'none',border:'none',color:D.gM,fontFamily:FS,fontSize:9.5,letterSpacing:'0.1em',cursor:'pointer',fontWeight:500,textDecoration:'underline',padding:0}}>No account? Create one</button>
          </div>
        </div>
      </div>

      {/* Continue without account */}
      <div style={{marginTop:18,textAlign:'center'}}>
        <button type="button" onClick={()=>setShowGuestWarning(true)} style={{background:'none',border:'none',color:D.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.1em',cursor:'pointer',fontWeight:400,textDecoration:'underline',padding:0,opacity:0.7}}>Continue without an account</button>
      </div>

      {/* Guest warning modal */}
      {showGuestWarning&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&setShowGuestWarning(false)}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
                <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:D.gT,letterSpacing:'0.08em'}}>Guest Mode</div>
                <button type="button" onClick={()=>setShowGuestWarning(false)} style={{background:'none',border:'none',color:D.gM,fontSize:18,cursor:'pointer',lineHeight:1,padding:4}}>✕</button>
              </div>
              <div style={{fontFamily:FB,fontSize:13,color:D.gM,lineHeight:1.8,marginBottom:20}}>
                <div style={{marginBottom:10,color:D.gT,fontWeight:500}}>Without an account, please note:</div>
                <div style={{display:'flex',flexDirection:'column',gap:7}}>
                  <div style={{display:'flex',gap:10,alignItems:'flex-start'}}><span style={{color:D.gD,flexShrink:0,marginTop:1}}>✕</span><span>Reading history and recents won't be saved between sessions</span></div>
                  <div style={{display:'flex',gap:10,alignItems:'flex-start'}}><span style={{color:D.gD,flexShrink:0,marginTop:1}}>✕</span><span>Bookmarks will be lost when you close or refresh</span></div>
                  <div style={{display:'flex',gap:10,alignItems:'flex-start'}}><span style={{color:D.gD,flexShrink:0,marginTop:1}}>✕</span><span>Study notes won't sync or persist across devices</span></div>
                  <div style={{display:'flex',gap:10,alignItems:'flex-start'}}><span style={{color:'#6ab04c',flexShrink:0,marginTop:1}}>✓</span><span>Offline Bible downloads will work normally</span></div>
                  <div style={{display:'flex',gap:10,alignItems:'flex-start'}}><span style={{color:'#6ab04c',flexShrink:0,marginTop:1}}>✓</span><span>Full reading and Strong's features available</span></div>
                </div>
              </div>
              <button type="button" onClick={()=>{setShowGuestWarning(false);onAuth({id:'guest',email:'',guest:true});}} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:'pointer',marginBottom:10}}>Continue as Guest</button>
              <button type="button" onClick={()=>setShowGuestWarning(false)} style={{width:'100%',background:'none',border:`1px solid ${D.bd}`,borderRadius:6,color:D.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',padding:'9px 0',cursor:'pointer'}}>Back to Sign In</button>
            </div>
          </div>
        </div>
      )}

      {/* Signup modal */}
      {showSignup&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&closeSignup()}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:22}}>
                <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:D.gT,letterSpacing:'0.08em'}}>Create Account</div>
                <button type="button" onClick={closeSignup} style={{background:'none',border:'none',color:D.gM,fontSize:18,cursor:'pointer',lineHeight:1,padding:4}}>✕</button>
              </div>
              {suMsg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.greenTxt,lineHeight:1.6}}>{suMsg}</div>}
              {suErr&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.redTxt,wordBreak:'break-word'}}>{suErr}</div>}
              <div style={{marginBottom:14}}><Lbl c="Email" T={D}/><Inp val={suEmail} set={setSuEmail} ph="you@example.com" T={D} type="email"/></div>
              <div style={{marginBottom:22}}>
                <Lbl c="Password" T={D}/>
                <div style={{position:'relative'}}>
                  <input className="s-btn" type={showSuPw?'text':'password'} value={suPw} onChange={e=>setSuPw(e.target.value)}
                    onKeyDown={e=>e.key==='Enter'&&doSignUp()} placeholder="••••••••" style={pwInputStyle}/>
                  <button type="button" onClick={()=>setShowSuPw(v=>!v)} style={eyeStyle} title={showSuPw?'Hide password':'Show password'}>{showSuPw?'🙈':'👁'}</button>
                </div>
              </div>
              <button type="button" onClick={doSignUp} disabled={suBusy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:suBusy?'default':'pointer',opacity:suBusy?.6:1}}>{suBusy?'…':'Create Account'}</button>
              <div style={{textAlign:'center',marginTop:14}}>
                <button type="button" onClick={closeSignup} style={{background:'none',border:'none',color:D.gM,fontFamily:FS,fontSize:9.5,letterSpacing:'0.1em',cursor:'pointer',fontWeight:500,textDecoration:'underline'}}>Already have an account? Sign in</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Forgot password modal */}
      {showForgot&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&closeForgot()}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:D.gT,letterSpacing:'0.08em'}}>Reset Password</div>
                <button type="button" onClick={closeForgot} style={{background:'none',border:'none',color:D.gM,fontSize:18,cursor:'pointer',lineHeight:1,padding:4}}>✕</button>
              </div>
              <div style={{fontFamily:FB,fontSize:13,color:D.mut,marginBottom:20,lineHeight:1.6}}>Enter your email and we'll send you a link to reset your password.</div>
              {forgotMsg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.greenTxt,lineHeight:1.6}}>{forgotMsg}</div>}
              {forgotErr&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:14,color:D.redTxt}}>{forgotErr}</div>}
              {!forgotMsg&&<>
                <div style={{marginBottom:20}}><Lbl c="Email" T={D}/><Inp val={forgotEmail} set={setForgotEmail} ph="you@example.com" T={D} type="email"/></div>
                <button type="button" onClick={doForgotPassword} disabled={forgotBusy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:forgotBusy?'default':'pointer',opacity:forgotBusy?.6:1}}>{forgotBusy?'…':'Send Reset Link'}</button>
              </>}
              {forgotMsg&&<button type="button" onClick={closeForgot} style={{width:'100%',marginTop:4,background:'none',border:`1px solid ${D.bd}`,borderRadius:6,color:D.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',padding:'9px 0',cursor:'pointer'}}>Back to Sign In</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ══════════════════════════════════════════════════════════
//  BOOKMARKS & RECENTS PANELS
// ══════════════════════════════════════════════════════════
function BookmarksPanel({T,bookmarks,onDelete,onOpen,onClose,versions}){
  return(
    <Modal title="✦ Bookmarks" onClose={onClose} T={T} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {bookmarks.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>No bookmarks yet. In Reading Mode, tap any verse to bookmark it.</div>}
      {bookmarks.map(bm=>{
        const bk=BIBLE.find(b=>b.n===bm.book_num);const ver=versions.find(v=>v.id===bm.version_id);
        const ref=`${bk?.name||'?'} ${bm.chapter}${bm.verse?':'+bm.verse:''}`;
        return(
          <div key={bm.id} style={{display:'flex',alignItems:'center',gap:12,padding:'11px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{flex:1}}>
              <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.04em',marginBottom:3}}>{bm.label||ref}</div>
              <div style={{fontFamily:FB,fontSize:13,color:T.dim}}>{ref} {'\u00B7'} <span style={{color:T.gM}}>{ver?.label||bm.version_id.toUpperCase()}</span></div>
            </div>
            <button className="s-btn s-ghost" onClick={()=>onOpen(bm)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 10px',fontWeight:500}}>Open</button>
            <IBtn T={T} ch="✕" danger onClick={()=>onDelete(bm.id)} title="Delete bookmark"/>
          </div>
        );
      })}
    </Modal>
  );
}

function RecentsPanel({T,recents,onOpen,onClose,versions}){
  return(
    <Modal title="↺ Recent Passages" onClose={onClose} T={T} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {recents.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>No recent passages yet. Browse chapters in Reading Mode.</div>}
      {recents.map(r=>{
        const bk=BIBLE.find(b=>b.n===r.book_num);const ver=versions.find(v=>v.id===r.version_id);
        return(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{flex:1}}>
              <span style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}>{bk?.name} {r.chapter}</span>
              <span style={{fontFamily:FB,fontSize:13,color:T.dim,marginLeft:10}}>{ver?.label||r.version_id.toUpperCase()}</span>
            </div>
            <div style={{fontFamily:FB,fontSize:12,color:T.dim}}>{fmtDate(r.visited_at)}</div>
            <button className="s-btn s-ghost" onClick={()=>onOpen(r)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 10px',fontWeight:500}}>Read</button>
          </div>
        );
      })}
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════
//  VERSIONS MODAL  (manage + upload — unified)
// ══════════════════════════════════════════════════════════
function VersionsModal({data,onSave,onClose,T,dlStates={},onDownload,onDeleteLocal}){
  const[vers,setVers]=useState(clone(data.versions));
  const builtinAvail=PUBLIC_VERSIONS.filter(pv=>!vers.find(v=>v.id===pv.id));

  function remove(id){setVers(v=>v.filter(x=>x.id!==id));}
  function addBuiltin(pv){setVers(v=>[...v,{id:pv.id,label:pv.label,lang:pv.lang,isRef:false}]);}
  function doSave(){let v=[...vers];if(!v.some(x=>x.isRef)&&v.length)v[0]={...v[0],isRef:true};onSave(v);}

  return(
    <Modal title="Bible Versions" onClose={onClose} wide T={T} footer={<><SBtn ch="Cancel" onClick={onClose} T={T}/><PBtn ch="Save" onClick={doSave} T={T}/></>}>
      {/* Current versions */}
      {vers.length===0&&<div style={{padding:'18px 0',textAlign:'center',fontFamily:FB,fontSize:15,color:T.dim}}>No versions added yet.</div>}
      {vers.map((v,i)=>{
        const dl=dlStates[v.id]||{};
        const isBuiltin=PUBLIC_VERSIONS.some(pv=>pv.id===v.id);
        return(
          <div key={v.id} style={{padding:'11px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:16,color:T.body,fontWeight:500}}>{v.label}</div>
                <div style={{fontFamily:FS,fontSize:8.5,color:T.dim,marginTop:2,letterSpacing:'0.08em'}}>{v.id} · {v.lang}{i===0?' · default':''}</div>
              </div>
              {/* Offline download controls (built-in versions only) */}
              {isBuiltin&&onDownload&&(
                dl.downloading?(
                  <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.08em',whiteSpace:'nowrap'}}>
                    {dl.total>0?`${Math.round((dl.progress/dl.total)*100)}%`:'…'}
                  </span>
                ):dl.downloaded?(
                  <button onClick={()=>onDeleteLocal(v.id)} title="Remove offline copy" style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                    ✓ Offline
                  </button>
                ):(
                  <button onClick={()=>onDownload(v.id)} title="Download for offline use" style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                    ↓ Offline
                  </button>
                )
              )}
              <button onClick={()=>remove(v.id)} disabled={vers.length===1} style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,padding:'5px 11px',fontSize:13,cursor:vers.length===1?'default':'pointer',opacity:vers.length===1?0.4:1}}>✕</button>
            </div>
            {/* Progress bar */}
            {isBuiltin&&dl.downloading&&dl.total>0&&(
              <div style={{marginTop:6,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${Math.round((dl.progress/dl.total)*100)}%`,background:T.gT,borderRadius:1,transition:'width .2s'}}/>
              </div>
            )}
            {dl.err&&<div style={{fontFamily:FB,fontSize:12,color:T.redTxt,marginTop:4}}>{dl.err}</div>}
          </div>
        );
      })}
      {/* Add built-in versions */}
      {builtinAvail.length>0&&(
        <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
          <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>BUILT-IN VERSIONS</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {builtinAvail.map(pv=>(
              <button key={pv.id} onClick={()=>addBuiltin(pv)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FB,fontSize:15,padding:'8px 16px',cursor:'pointer'}}>＋ {pv.label}</button>
            ))}
          </div>
        </div>
      )}
      {/* Request a new version */}
      <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
        <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>REQUEST A VERSION</div>
        <div style={{fontFamily:FB,fontSize:13,color:T.dim,lineHeight:1.7}}>To request a new Bible version or translation to be added to Scriptorium, please contact the app creator.</div>
      </div>
    </Modal>
  );
}


// ══════════════════════════════════════════════════════════
//  ENTRY CARD  (enhanced with reading-mode link)
// ══════════════════════════════════════════════════════════
function EntryCard({entry,versions,q,dark,T,onEdit,onDup,onDel,pulse,idx,onRead,readFontSize=19,readLineHeight=1.85,readFontFamily='serif'}){
  const[det,setDet]=useState(false);
  const hasDet=entry.notes||entry.greekHebrew||entry.sourceRefs;
  const prev=entry.notes?(entry.notes.length>120?entry.notes.slice(0,120)+'…':entry.notes):'';
  const typeColor=(dark?BD:BL)[entry.issueType]||(dark?BD.other:BL.other);
  const delay=typeof idx==='number'?Math.min(idx*0.06,0.3):0;
  const parsed=parseRefDD(entry.reference);
  return(
    <div id={`card-${entry.id}`} className={`entry-card hov-card fade-up${pulse?' pulse':''}`}
      style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:12,overflow:'hidden',boxShadow:`0 2px 8px rgba(0,0,0,${dark?.3:.06})`,animationDelay:`${delay}s`}}>
      <div style={{height:2,background:`linear-gradient(90deg, ${typeColor.bd}, ${typeColor.bd}60, transparent)`}}/>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'11px 18px',borderBottom:`1px solid ${T.bd}`}}>
        <span dangerouslySetInnerHTML={{__html:hl(entry.reference,q)}} style={{fontFamily:FS,fontSize:14.5,fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}/>
        {entry.issueLabel&&<Badge type={entry.issueType} label={entry.issueLabel} dark={dark}/>}
        <div style={{marginLeft:'auto',display:'flex',gap:5}}>
          {parsed&&onRead&&<button className="s-btn s-ghost" onClick={()=>onRead(parsed)} title="Read this chapter" style={{background:'none',border:`1px solid ${T.bd+'40'}`,borderRadius:5,color:T.dim,padding:'3px 8px',fontSize:12,fontFamily:FB}}>📖</button>}
          <IBtn T={T} ch="✎" onClick={()=>onEdit(entry.id)} title="Edit"/>
          <IBtn T={T} ch="⧉" onClick={()=>onDup(entry.id)} title="Duplicate"/>
          <IBtn T={T} ch="✕" onClick={()=>onDel(entry.id)} danger title="Delete"/>
        </div>
      </div>
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <tbody>
          {versions.map((v,vi)=>{
            const vd=entry.versions?.[v.id];if(!vd?.text)return null;
            const st=stSt(vd.status,T);
            return(<tr key={v.id} className="text-reveal" style={{background:st.bg,borderTop:vi>0?`1px solid ${T.bd}`:'none',animationDelay:`${vi*0.05}s`}}>
              <td style={{padding:'9px 16px',whiteSpace:'nowrap',fontFamily:FS,fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',color:st.txt,width:66,verticalAlign:'top',fontWeight:600}}>{v.label}</td>
              <td style={{padding:'9px 4px',fontFamily:FS,fontSize:9,color:T.dim,width:26,verticalAlign:'top',paddingTop:11,fontWeight:500}}>{v.lang}</td>
              <td style={{padding:'9px 16px 9px 6px',fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,lineHeight:readLineHeight,color:st.txt,verticalAlign:'top'}} dangerouslySetInnerHTML={{__html:hl(vd.text,q)}}/>
            </tr>);
          })}
        </tbody>
      </table>
      {!det&&prev&&<div className="text-reveal" style={{fontFamily:fontFamilyMap[readFontFamily],fontStyle:'italic',fontSize:readFontSize,color:T.dim,padding:'8px 18px',borderTop:`1px solid ${T.bd}`}} dangerouslySetInnerHTML={{__html:hl(prev,q)}}/>}
      {hasDet&&(<>
        <div className="s-btn s-ghost" onClick={()=>setDet(!det)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 18px',fontFamily:FS,fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:T.dim,borderTop:`1px solid ${T.bd}`,background:T.bgCH,userSelect:'none',fontWeight:500}}>
          <span style={{display:'inline-block',transition:'transform .2s',transform:det?'rotate(90deg)':'none',fontSize:8}}>▸</span> Details
        </div>
        {det&&(<div className="slide-down" style={{padding:'14px 20px',borderTop:`1px solid ${T.bd}`}}>
          {entry.notes&&<><Lbl c="Notes / Analysis" T={T}/><div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.mut,lineHeight:readLineHeight,marginBottom:14}} dangerouslySetInnerHTML={{__html:hl(entry.notes,q)}}/></>}
          {entry.greekHebrew&&<><Lbl c="Greek / Hebrew" T={T}/><div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.mut,lineHeight:readLineHeight,marginBottom:14}} dangerouslySetInnerHTML={{__html:hl(entry.greekHebrew,q)}}/></>}
          {entry.sourceRefs&&<><Lbl c="Source References" T={T}/><div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.mut,lineHeight:readLineHeight}} dangerouslySetInnerHTML={{__html:hl(entry.sourceRefs,q)}}/></>}
        </div>)}
      </>)}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
//  SECTION
// ══════════════════════════════════════════════════════════
function Section({sec,entries,versions,q,dark,T,onEditSec,onDelSec,onEdit,onDup,onDel,pulseId,secToggle,idx,onRead,readFontSize=19,readLineHeight=1.85,readFontFamily='serif'}){
  const[col,setCol]=useState(false);const[sortBy,setSortBy]=useState('default');
  useEffect(()=>{if(secToggle)setCol(secToggle.action==='collapse');},[secToggle]);
  const delay=Math.min((idx||0)*0.08,0.4);
  const sorted=useMemo(()=>{
    if(sortBy==='default')return entries;
    const copy=[...entries];
    if(sortBy==='bible')copy.sort((a,b)=>{const pa=parseRefDD(a.reference),pb=parseRefDD(b.reference);if(!pa&&!pb)return 0;if(!pa)return 1;if(!pb)return-1;if(pa.bookNum!==pb.bookNum)return pa.bookNum-pb.bookNum;if(pa.chapter!==pb.chapter)return pa.chapter-pb.chapter;return pa.verse-pb.verse;});
    else if(sortBy==='issue')copy.sort((a,b)=>(a.issueType||'').localeCompare(b.issueType||''));
    else if(sortBy==='status'){const rank={corrupt:0,missing:1,partial:2,diff:3,faithful:4,reference:5};copy.sort((a,b)=>{const sa=Math.min(...Object.values(a.versions||{}).map(v=>(rank[v.status]!==undefined?rank[v.status]:3)));const sb=Math.min(...Object.values(b.versions||{}).map(v=>(rank[v.status]!==undefined?rank[v.status]:3)));return sa-sb;});}
    return copy;
  },[entries,sortBy]);
  return(
    <div className="section-enter" style={{marginBottom:28,animationDelay:`${delay}s`}}>
      <div className="s-btn" onClick={()=>setCol(!col)}
        style={{display:'flex',alignItems:'center',gap:8,background:T.bgSec,border:`1px solid ${T.bdA}`,borderRadius:col?10:'10px 10px 0 0',padding:'13px 12px',userSelect:'none',transition:'border-radius .2s',flexWrap:'wrap'}}>
        <span style={{color:T.gM,fontSize:9,display:'inline-block',transition:'transform .2s',transform:col?'rotate(-90deg)':'none'}}>▼</span>
        <span style={{fontFamily:FS,fontSize:12.5,fontWeight:600,color:T.gT,letterSpacing:'0.04em',flex:1,minWidth:60}}>{sec.title}</span>
        <span style={{fontFamily:FS,fontSize:9.5,color:T.dim,letterSpacing:'0.1em',fontWeight:500}}>{entries.length} {entries.length===1?'entry':'entries'}</span>
        <div style={{display:'flex',gap:5}} onClick={e=>e.stopPropagation()}>
          <select className="s-btn hide-mobile" value={sortBy} onChange={e=>{e.stopPropagation();setSortBy(e.target.value);}} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:8.5,letterSpacing:'0.06em',padding:'3px 6px',outline:'none',cursor:'pointer'}}>
            <option value="default">Sort: Default</option><option value="bible">Sort: Bible Order</option><option value="issue">Sort: Issue Type</option><option value="status">Sort: Status</option>
          </select>
          <IBtn T={T} ch="✎" onClick={()=>onEditSec(sec.id)}/>
          <IBtn T={T} ch="✕" onClick={()=>onDelSec(sec.id)} danger/>
        </div>
      </div>
      {!col&&(<div className="slide-down" style={{border:`1px solid ${T.bdA}`,borderTop:'none',borderRadius:'0 0 10px 10px',background:T.bg,padding:14}}>
        {sec.description&&<div className="text-reveal" style={{fontFamily:fontFamilyMap[readFontFamily],fontStyle:'italic',color:T.mut,fontSize:readFontSize,padding:'8px 14px 14px',borderBottom:`1px solid ${T.bd}`,marginBottom:14,lineHeight:readLineHeight}}>{sec.description}</div>}
        {entries.length===0&&<div style={{textAlign:'center',padding:'28px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>No entries yet. Add one above.</div>}
        {sorted.map((e,i)=><EntryCard key={e.id} entry={e} versions={versions} q={q} dark={dark} T={T} onEdit={onEdit} onDup={onDup} onDel={onDel} pulse={pulseId===e.id} idx={i} onRead={onRead} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>)}
      </div>)}
    </div>
  );
}


// ══════════════════════════════════════════════════════════
//  ENTRY MODAL  (with DB auto-fill)
// ══════════════════════════════════════════════════════════
function EntryModal({entry,sections,versions,onSave,onClose,T,dark}){
  const isEdit=!!entry._isEdit;
  const pd=parseRefDD(entry.reference||'');
  const[bkN,setBkN]=useState(pd?.bookNum||0);const[ch,setCh]=useState(pd?.chapter||0);const[vs,setVs]=useState(pd?.verse||0);
  const[secId,setSecId]=useState(entry.sectionId||sections[0]?.id||'');
  const[label,setLabel]=useState(entry.issueLabel||'');const[iType,setIType]=useState(entry.issueType||'manuscript');
  const[notes,setNotes]=useState(entry.notes||'');const[greek,setGreek]=useState(entry.greekHebrew||'');const[src,setSrc]=useState(entry.sourceRefs||'');
  const[vTxt,setVTxt]=useState(Object.fromEntries(versions.map(v=>[v.id,entry.versions?.[v.id]?.text||''])));
  const[vSt,setVSt]=useState(Object.fromEntries(versions.map(v=>[v.id,entry.versions?.[v.id]?.status||(v.isRef?'reference':'faithful')])));
  const[refErr,setRefErr]=useState(false);const[filling,setFilling]=useState(false);const[saving,setSaving]=useState(false);const[confirm,setConfirm]=useState(null);

  function getRef(){if(!bkN||!ch||!vs)return'';const b=BIBLE.find(x=>x.n===bkN);return b?`${b.name} ${ch}:${vs}`:''}

  async function doFill(){
    if(!bkN||!ch||!vs)return;setFilling(true);
    const filled=await dbAutoFill(bkN,ch,vs,versions.map(v=>v.id));
    setVTxt(t=>({...t,...filled}));setFilling(false);
  }

  async function commitSave(){
    setSaving(true);
    const ref=getRef();
    const vdata={};
    for(const v of versions){const txt=vTxt[v.id]||'';const st=vSt[v.id]||'faithful';if(txt)vdata[v.id]={text:txt,status:st};}
    await onSave({...entry,reference:ref,sectionId:secId,issueLabel:label,issueType:iType,notes,greekHebrew:greek,sourceRefs:src,versions:vdata});
    setSaving(false);
  }

  async function attemptSave(){
    const ref=getRef();if(!ref){setRefErr(true);return;}setRefErr(false);
    if(isEdit){setConfirm('save');return;}
    await commitSave();
  }

  const footer=(<>
    <SBtn ch="Cancel" onClick={onClose} T={T}/>
    <PBtn ch={saving?'Saving…':(isEdit?'Save Changes':'Add Entry')} onClick={attemptSave} T={T} disabled={saving}/>
  </>);

  return(<>
    <Modal title={isEdit?'✎ Edit Entry':'＋ Add Entry'} onClose={onClose} wide T={T} footer={footer}>
      <div className="form-row" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:18}}>
        <div>
          <Lbl c="Reference" T={T} req/>
          <RefDD bkN={bkN} setBkN={setBkN} ch={ch} setCh={setCh} vs={vs} setVs={setVs} T={T} err={refErr}/>
          <button className="s-btn" onClick={doFill} disabled={!bkN||!ch||!vs||filling} style={{marginTop:8,background:T.bgSec,border:`1px dashed ${T.gD}`,color:T.gM,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'6px 13px',borderRadius:5,opacity:(!bkN||!ch||!vs||filling)?.45:1,fontWeight:500}}>{filling?<><Spinner/> Filling…</>:'⚡ Auto-fill from Database'}</button>
        </div>
        <div><Lbl c="Section" T={T} req/><Sel val={secId} set={setSecId} T={T}>{sections.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</Sel></div>
      </div>
      <div className="form-row" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:18}}>
        <div><Lbl c="Issue Label" T={T}/><Inp val={label} set={setLabel} ph="e.g. Manuscript — Comma Johanneum" T={T}/></div>
        <div><Lbl c="Issue Type" T={T}/><Sel val={iType} set={setIType} T={T}>{ISSUE_TYPES.map(t=><option key={t} value={t}>{ISSUE_LABELS[t]||t}</option>)}</Sel></div>
      </div>
      <div style={{marginBottom:18}}><Lbl c="Notes / Analysis" T={T}/><TA val={notes} set={setNotes} T={T} rows={4}/></div>
      <div className="form-row" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:18}}>
        <div><Lbl c="Greek / Hebrew" T={T}/><TA val={greek} set={setGreek} T={T} rows={3}/></div>
        <div><Lbl c="Source References" T={T}/><TA val={src} set={setSrc} T={T} rows={3}/></div>
      </div>
      <OrnRule T={T}/>
      <Lbl c="Version Texts & Status" T={T}/>
      {versions.map(v=>(
        <div key={v.id} style={{marginBottom:16,padding:'14px 16px',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
            <span style={{fontFamily:FS,fontSize:10.5,fontWeight:600,color:T.gT,letterSpacing:'0.08em'}}>{v.label}</span>
            <select className="s-btn" value={vSt[v.id]||'faithful'} onChange={e=>setVSt(s=>({...s,[v.id]:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FS,fontSize:9,letterSpacing:'0.06em',padding:'4px 8px',outline:'none'}}>
              {STATUS_VALUES.map(s=><option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <TA val={vTxt[v.id]||''} set={t=>setVTxt(x=>({...x,[v.id]:t}))} ph={`${v.label} verse text…`} T={T} rows={3}/>
        </div>
      ))}
    </Modal>
    {confirm==='save'&&<ConfirmDialog T={T} title="Save Changes?" message="Update this entry with your changes?" confirmLabel="Save Changes" cancelLabel="Go Back" onConfirm={async()=>{setConfirm(null);await commitSave();}} onCancel={()=>setConfirm(null)}/>}
  </>);
}

function SecModal({sec,onSave,onClose,T}){
  const[title,setTitle]=useState(sec?.title||'');const[desc,setDesc]=useState(sec?.description||'');
  return(
    <Modal title={sec?'✎ Edit Section':'＋ Add Section'} onClose={onClose} T={T} footer={<><SBtn ch="Cancel" onClick={onClose} T={T}/><PBtn ch={sec?'Save Changes':'Add Section'} onClick={()=>{if(title)onSave({...sec,title,description:desc,_isNew:!sec?.id});}} T={T}/></>}>
      <div style={{marginBottom:16}}><Lbl c="Title" T={T} req/><Inp val={title} set={setTitle} ph="§ I — Section Title" T={T}/></div>
      <div><Lbl c="Description" T={T}/><TA val={desc} set={setDesc} T={T} rows={4}/></div>
    </Modal>
  );
}



// ══════════════════════════════════════════════════════════
//  FILTER BAR  &  NAV BAR
// ══════════════════════════════════════════════════════════
function FilterBar({filters,setFilters,versions,T,hiddenVers,togVer,onExpand,onCollapse}){
  const[open,setOpen]=useState(false);
  const active=filters.issueTypes.length+filters.statuses.length+(filters.vA&&filters.vB?1:0);
  const togI=t=>setFilters(f=>({...f,issueTypes:f.issueTypes.includes(t)?f.issueTypes.filter(x=>x!==t):[...f.issueTypes,t]}));
  const togS=s=>setFilters(f=>({...f,statuses:f.statuses.includes(s)?f.statuses.filter(x=>x!==s):[...f.statuses,s]}));
  return(
    <div className="no-print" style={{borderTop:`1px solid ${T.bdS}`}}>
      <div style={{display:'flex',alignItems:'center'}}>
        <div className="s-btn s-ghost" onClick={()=>setOpen(!open)} style={{display:'flex',alignItems:'center',gap:9,padding:'5px 24px',fontFamily:FS,fontSize:9.5,color:T.dim,letterSpacing:'0.1em',userSelect:'none',fontWeight:500,flexShrink:0}}>
          <span style={{transform:open?'rotate(90deg)':'none',display:'inline-block',transition:'transform .2s',fontSize:8}}>▸</span>
          <span>Filters</span>
          {active>0&&<span style={{background:T.gF,border:`1px solid ${T.gD}`,color:T.gM,fontSize:9,padding:'1px 7px',borderRadius:10,fontWeight:600}}>{active}</span>}
        </div>
        {hiddenVers!==undefined&&togVer&&(
          <div style={{display:'flex',alignItems:'center',gap:5,marginLeft:'auto',paddingRight:16}}>
            <span style={{fontFamily:FS,fontSize:8,letterSpacing:'0.12em',textTransform:'uppercase',color:T.dim,fontWeight:500,flexShrink:0}}>Show:</span>
            {versions.map(v=>{const hidden=hiddenVers.includes(v.id);return(
              <button key={v.id} type="button" onClick={()=>togVer(v.id)}
                style={{background:hidden?'transparent':T.gF,border:`1px solid ${hidden?T.bd:T.gD}`,borderRadius:6,color:hidden?T.dim:T.gT,fontFamily:FS,fontSize:7,letterSpacing:'0.08em',padding:'2px 7px',fontWeight:hidden?400:600,opacity:hidden?.5:1,cursor:'pointer',transition:'all .15s',textDecoration:hidden?'line-through':'none'}}>
                {v.label}
              </button>);})}
            {(onExpand||onCollapse)&&<>
              <div style={{width:1,height:14,background:T.bd,marginLeft:3}}/>
              <button type="button" title="Expand all" onClick={onExpand}
                style={{background:'transparent',border:'none',color:T.dim,fontFamily:FS,fontSize:11,padding:'2px 5px',cursor:'pointer',lineHeight:1}}>▾</button>
              <button type="button" title="Collapse all" onClick={onCollapse}
                style={{background:'transparent',border:'none',color:T.dim,fontFamily:FS,fontSize:11,padding:'2px 5px',cursor:'pointer',lineHeight:1}}>▴</button>
            </>}
          </div>
        )}
      </div>
      {open&&(<div className="slide-down" style={{padding:'12px 24px 16px',background:T.bgSec,display:'flex',flexWrap:'wrap',gap:18}}>
        <div><Lbl c="Issue Type" T={T}/><div style={{display:'flex',flexWrap:'wrap',gap:5}}>{ISSUE_TYPES.map(t=>(<label key={t} className="s-btn" style={{display:'flex',alignItems:'center',gap:5,fontFamily:FB,fontSize:13,color:T.mut,cursor:'pointer',padding:'4px 10px',border:`1px solid ${filters.issueTypes.includes(t)?T.gD:T.bd}`,borderRadius:5,background:T.bgCard}}><input type="checkbox" checked={filters.issueTypes.includes(t)} onChange={()=>togI(t)} style={{accentColor:T.g}}/>{ISSUE_LABELS[t]||t}</label>))}</div></div>
        <div><Lbl c="Status" T={T}/><div style={{display:'flex',flexWrap:'wrap',gap:5}}>{['faithful','corrupt','diff','partial','missing'].map(s=>(<label key={s} className="s-btn" style={{display:'flex',alignItems:'center',gap:5,fontFamily:FB,fontSize:13,color:T.mut,cursor:'pointer',padding:'4px 10px',border:`1px solid ${filters.statuses.includes(s)?T.gD:T.bd}`,borderRadius:5,background:T.bgCard}}><input type="checkbox" checked={filters.statuses.includes(s)} onChange={()=>togS(s)} style={{accentColor:T.g}}/>{STATUS_LABELS[s]}</label>))}</div></div>
        <div><Lbl c="Version Alignment" T={T}/><div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          <select className="s-btn" value={filters.vA} onChange={e=>setFilters(f=>({...f,vA:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FB,fontSize:13,padding:'5px 9px',outline:'none'}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
          <span style={{color:T.dim,fontFamily:FS,fontSize:11}}>≠</span>
          <select className="s-btn" value={filters.vB} onChange={e=>setFilters(f=>({...f,vB:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FB,fontSize:13,padding:'5px 9px',outline:'none'}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
        </div></div>
        <button className="s-btn s-ghost" onClick={()=>setFilters({issueTypes:[],statuses:[],vA:'',vB:''})} style={{alignSelf:'flex-end',background:'none',border:`1px solid ${T.bd}`,color:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'5px 12px',borderRadius:5,fontWeight:500}}>✕ Clear</button>
      </div>)}
    </div>
  );
}

function NavBar({data,T,setQ,onScroll,inline}){
  const[bk,setBk]=useState('');const[ch,setCh]=useState('');const[vs,setVs]=useState('');
  function books(){const s=new Set();for(const e of data.entries){const p=parseRef(e.reference);if(p)s.add(p.book);}const order=BIBLE.map(b=>b.name);return[...s].sort((a,b)=>order.indexOf(a)-order.indexOf(b));}
  function chapters(b){const s=new Set();for(const e of data.entries){const p=parseRef(e.reference);if(p&&p.book===b)s.add(p.chapter);}return[...s].sort((a,c)=>parseInt(a)-parseInt(c));}
  function verses(b,c){const o=[];for(const e of data.entries){const p=parseRef(e.reference);if(p&&p.book===b&&p.chapter===c)o.push({label:p.verse,ref:e.reference});}return o;}
  const bks=books();if(!bks.length)return null;const chs=bk?chapters(bk):[];const vss=(bk&&ch)?verses(bk,ch):[];
  const dd=(a)=>({background:T.bgIn,border:`1px solid ${T.bd}`,color:a?T.mut:T.dim,fontFamily:FB,fontSize:13,padding:'4px 7px',borderRadius:5,opacity:a?1:.4,outline:'none'});
  const inner=(<>
    <span style={{fontFamily:FS,fontSize:8.5,color:T.gM,letterSpacing:'0.1em',textTransform:'uppercase',flexShrink:0,fontWeight:600}}>Go to</span>
    <select className="s-btn" value={bk} onChange={e=>{setBk(e.target.value);setCh('');setVs('');setQ(e.target.value||'');}} style={dd(true)}><option value="">— Book —</option>{bks.map(b=><option key={b} value={b}>{b}</option>)}</select>
    <select className="s-btn" value={ch} disabled={!bk} onChange={e=>{setCh(e.target.value);setVs('');setQ(bk+' '+e.target.value);}} style={dd(!!bk)}><option value="">— Ch —</option>{chs.map(c=><option key={c} value={c}>{c}</option>)}</select>
    <select className="s-btn" value={vs} disabled={!ch} onChange={e=>{const r=e.target.value;setVs(r);if(r){setQ('');onScroll(r);}}} style={dd(!!ch)}><option value="">— Vs —</option>{vss.map(v=><option key={v.ref} value={v.ref}>{v.label}</option>)}</select>
    {bk&&<button type="button" className="s-btn s-ghost" onClick={()=>{setBk('');setCh('');setVs('');setQ('');}} style={{background:'none',border:'none',color:T.dim,fontFamily:FS,fontSize:10}}>✕</button>}
  </>);
  if(inline)return <>{inner}</>;
  return(
    <div className="no-print" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',padding:'4px 16px 6px',borderTop:`1px solid ${T.bdS}`,background:T.bgSec}}>
      {inner}
    </div>
  );
}


// ══════════════════════════════════════════════════════════
//  STATS MODAL
// ══════════════════════════════════════════════════════════
function StatsModal({data,T,onClose}){
  const refVer=data.versions.find(v=>v.isRef);const refLabel=refVer?.label||'Ref';
  const total=data.entries.length;
  const vStats=data.versions.map(v=>{let t=0,faithful=0,corrupt=0,differs=0,partial=0,absent=0;for(const e of data.entries){const vd=e.versions?.[v.id];if(vd?.text){t++;if(vd.status==='faithful'||vd.status==='reference')faithful++;else if(vd.status==='corrupt')corrupt++;else if(vd.status==='diff')differs++;else if(vd.status==='partial')partial++;else if(vd.status==='missing')absent++;}}return{v,t,faithful,corrupt,differs,partial,absent,pct:t>0?Math.round((faithful/t)*100):0};});
  const iC={};for(const e of data.entries)if(e.issueType)iC[e.issueType]=(iC[e.issueType]||0)+1;
  const iCol={manuscript:'#d46868',word:'#cc9a38',omission:'#9468c0',article:'#48b8b8',grammar:'#58a0c0',doctrine:'#b86828',name:'#b8a848',other:'#786248'};
  const tc={padding:'7px 12px',fontFamily:FB,fontSize:14,borderBottom:`1px solid ${T.bd}`,color:T.body,textAlign:'center'};
  const th={...tc,fontFamily:FS,fontSize:9,letterSpacing:'0.1em',textTransform:'uppercase',color:T.gM,fontWeight:600,borderBottom:`2px solid ${T.bdA}`};
  return(
    <Modal title="Statistics" onClose={onClose} wide T={T} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      <div style={{fontFamily:FB,fontSize:15,color:T.mut,marginBottom:14,lineHeight:1.7}}>{total} passage{total!==1?'s':''} across {data.sections.length} section{data.sections.length!==1?'s':''}, comparing {data.versions.length} version{data.versions.length!==1?'s':''}.</div>
      <OrnRule T={T}/>
      <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:10,marginTop:12,fontWeight:600}}>Version Agreement with {refLabel}</div>
      <div style={{overflowX:'auto',marginBottom:16}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:500}}>
          <thead><tr>{['Version','Passages','Faithful','Corrupt','Differs','Partial','Absent','Agreement'].map(h=><th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>{vStats.map(({v,t,faithful,corrupt,differs,partial,absent,pct})=>(<tr key={v.id}><td style={{...tc,textAlign:'left',fontWeight:600,color:T.gT}}>{v.label}{v.isRef?' (Ref)':''}</td><td style={tc}>{t}</td><td style={{...tc,color:T.greenTxt}}>{faithful}</td><td style={{...tc,color:T.redTxt}}>{corrupt}</td><td style={{...tc,color:T.difTxt}}>{differs}</td><td style={{...tc,color:T.oraTxt}}>{partial}</td><td style={{...tc,color:T.purTxt}}>{absent}</td><td style={{...tc,fontWeight:600,color:pct>80?T.greenTxt:pct>50?T.ambTxt:T.redTxt}}>{pct}%</td></tr>))}</tbody>
        </table>
      </div>
      {Object.keys(iC).length>0&&(<>
        <OrnRule T={T}/>
        <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:10,marginTop:12,fontWeight:600}}>Issues by Type</div>
        {Object.entries(iC).sort(([,a],[,b])=>b-a).map(([t,n])=>{const mx=Math.max(1,...Object.values(iC));return(
          <div key={t} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
            <span style={{fontFamily:FS,fontSize:10,color:T.dim,width:90,flexShrink:0,fontWeight:500}}>{ISSUE_LABELS[t]||t}</span>
            <div style={{flex:1,height:6,background:T.bgSec,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.round((n/mx)*100)}%`,background:iCol[t]||'#786248',borderRadius:3}}/></div>
            <span style={{fontFamily:FB,fontSize:14,color:T.body,minWidth:24,textAlign:'right'}}>{n}</span>
          </div>);
        })}
      </>)}
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════
//  UNDO TOAST
// ══════════════════════════════════════════════════════════
function UndoToast({ud,onUndo,onDismiss,T}){
  if(!ud)return null;
  return(<div className="no-print fade-up" style={{position:'fixed',bottom:28,left:'50%',transform:'translateX(-50%)',zIndex:300,minWidth:340,background:T.bgCH,border:`1px solid ${T.g}40`,borderRadius:10,overflow:'hidden',boxShadow:`0 8px 40px rgba(0,0,0,0.5)`}}>
    <div style={{display:'flex',alignItems:'center',gap:14,padding:'13px 18px'}}>
      <span style={{fontFamily:FS,fontSize:9.5,letterSpacing:'0.14em',textTransform:'uppercase',color:T.g,flexShrink:0,fontWeight:600}}>Deleted</span>
      <span style={{fontFamily:FB,fontSize:15,color:T.mut,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ud.label}</span>
      <button className="s-btn" onClick={onUndo} style={{background:T.g,border:'none',color:'#0e0d0b',fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'5px 13px',borderRadius:4,fontWeight:600,flexShrink:0}}>↩ Undo</button>
      <button className="s-btn s-ghost" onClick={onDismiss} style={{background:'none',border:'none',color:T.dim,fontSize:14,padding:'2px 6px',flexShrink:0}}>✕</button>
    </div>
    <div style={{height:3,background:T.bd}}><div style={{height:'100%',width:`${ud.pct}%`,background:T.g,transition:'width 0.1s linear'}}/></div>
  </div>);
}


// ══════════════════════════════════════════════════════════
//  MOBILE BOTTOM SHEET
// ══════════════════════════════════════════════════════════
function MobileSheet({onClose,children,T,title,onScroll,fromTop,fullScreen,sheetHeight,maxSheetHeight,isClosing,topOffset=0,noScroll=false,topPad}){
  const[dragY,setDragY]=React.useState(0);
  const[internalClosing,setInternalClosing]=React.useState(false);
  const[entered,setEntered]=React.useState(false);
  const closing=isClosing||internalClosing;
  const handleRef=React.useRef(null);
  const startY=React.useRef(null);
  const startTime=React.useRef(0);
  const lastDY=React.useRef(0);

  function dismiss(){setInternalClosing(true);onClose();}

  function onTouchStart(e){startY.current=e.touches[0].clientY;startTime.current=Date.now();lastDY.current=0;}
  function onTouchMove(e){
    if(startY.current===null)return;
    const raw=e.touches[0].clientY-startY.current;
    lastDY.current=raw;
    if(fromTop)setDragY(raw<0?raw:raw*0.2);
    else setDragY(raw>0?raw:raw*0.2);
  }
  function onTouchEnd(){
    if(startY.current!==null){
      const elapsed=Date.now()-startTime.current;
      const absDY=Math.abs(lastDY.current);
      const vel=absDY/(elapsed||1)*1000;
      if(absDY>60||(vel>300&&absDY>15)){dismiss();}
      else{setDragY(0);}
    }
    startY.current=null;lastDY.current=0;
  }

  const dragTx=`translateY(${dragY}px)`;
  const backdropOpacity=dragY!==0?Math.max(0,1-Math.abs(dragY)/300):1;

  return(
    <div onClick={e=>{if(e.target===e.currentTarget)dismiss();}}
      style={{position:'fixed',inset:0,zIndex:180,background:`rgba(0,0,0,${closing?0:0.55*backdropOpacity})`,backdropFilter:`blur(${closing?0:3*backdropOpacity}px)`,
        opacity:closing?0:1,transition:closing?'opacity .25s ease-in':'none'}}>
      <div className={closing?(fromTop?'slide-down-sheet-out':'slide-up-sheet-out'):(!entered?(fromTop?'slide-down-sheet':'slide-up-sheet'):'')} onAnimationEnd={()=>{if(!closing)setEntered(true);}} onClick={e=>e.stopPropagation()}
        style={{position:'absolute',...(fromTop?{top:topOffset}:{bottom:0}),left:0,right:0,background:T.bgCard,
          borderRadius:fromTop?'0 0 18px 18px':'18px 18px 0 0',
          ...(fromTop?{borderBottom:`2px solid ${T.bdA}`}:{borderTop:`2px solid ${T.bdA}`}),
          maxHeight:sheetHeight||maxSheetHeight||(fullScreen?'100vh':fromTop?`calc(100vh - ${topOffset}px - 50px)`:'82vh'),height:sheetHeight||(fullScreen?'100vh':undefined),display:'flex',flexDirection:'column',overflow:'hidden',
          boxShadow:fromTop?'0 20px 60px rgba(0,0,0,0.5)':'0 -20px 60px rgba(0,0,0,0.5)',
          transform:(!closing&&dragY!==0)?dragTx:undefined,
          transition:(!closing&&dragY===0)?'transform .2s ease-out, max-height .12s cubic-bezier(0.4,0,0.2,1), height .12s cubic-bezier(0.4,0,0.2,1)':'none'}}>

        {!fromTop&&<div style={{height:3,background:T.accentLine}}/>}
        {!fromTop&&<div ref={!fromTop?handleRef:undefined} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          style={{display:'flex',flexDirection:'column',alignItems:'center',padding:'10px 0 2px',flexShrink:0,touchAction:'none',cursor:'grab'}}>
          <div style={{width:36,height:4,background:T.bdA,borderRadius:2,marginBottom:6}}/>
          {title&&<div style={{fontFamily:FS,fontSize:11,fontWeight:600,color:T.gT,letterSpacing:'0.1em',marginBottom:2}}>{title}</div>}
        </div>}
        <div style={{overflowY:noScroll?'hidden':'auto',flex:1,padding:fromTop?`${topPad??20}px 18px 32px`:'6px 18px 32px',WebkitOverflowScrolling:'touch'}} onScroll={onScroll}>
          {children}
        </div>
        {fromTop&&<div ref={fromTop?handleRef:undefined} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          style={{display:'flex',flexDirection:'column',alignItems:'center',padding:'2px 0 10px',flexShrink:0,touchAction:'none',cursor:'grab'}}>
          {title&&<div style={{fontFamily:FS,fontSize:11,fontWeight:600,color:T.gT,letterSpacing:'0.1em',marginBottom:6}}>{title}</div>}
          <div style={{width:36,height:4,background:T.bdA,borderRadius:2}}/>
        </div>}
        {fromTop&&<div style={{height:3,background:T.accentLine}}/>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
//  RESET CONFIRM MODAL
// ══════════════════════════════════════════════════════════
function ResetConfirmModal({T,onConfirm,onCancel,entryCount,sectionCount}){
  const[typed,setTyped]=useState('');
  const CONFIRM_WORD='RESET';
  const ready=typed.trim().toUpperCase()===CONFIRM_WORD;
  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onCancel();}} style={{position:'fixed',inset:0,zIndex:500,background:'rgba(0,0,0,0.88)',display:'flex',alignItems:'center',justifyContent:'center',padding:24,backdropFilter:'blur(6px)'}}>
      <div className="modal-in" style={{background:'#160404',border:'2px solid #8a1a1a',borderRadius:14,width:'min(94vw,520px)',overflow:'hidden',boxShadow:'0 40px 100px rgba(160,10,10,0.5)'}}>
        <div style={{height:4,background:'linear-gradient(90deg,#4a0808,#c83030,#e05555,#c83030,#4a0808)'}}/>
        <div style={{padding:'28px 30px 10px'}}>
          <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:20}}>
            <div style={{width:44,height:44,borderRadius:'50%',background:'#2a0808',border:'2px solid #c83030',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              <span style={{fontSize:20}}>&#9888;</span>
            </div>
            <div>
              <div style={{fontFamily:FS,fontSize:15,fontWeight:700,letterSpacing:'0.06em',color:'#f08080',marginBottom:3}}>Reset to Defaults</div>
              <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'#8a3030',fontWeight:500}}>This action cannot be undone</div>
            </div>
          </div>
          <div style={{background:'#200808',border:'1px solid #6a1818',borderRadius:8,padding:'16px 18px',marginBottom:18}}>
            <div style={{fontFamily:FS,fontSize:9.5,letterSpacing:'0.12em',textTransform:'uppercase',color:'#d46868',marginBottom:10,fontWeight:600}}>The following will be permanently deleted:</div>
            <div style={{fontFamily:FB,fontSize:15,color:'#c09090',lineHeight:2}}>
              &#x2022; All <strong style={{color:'#f08080'}}>{entryCount} comparison {entryCount===1?'entry':'entries'}</strong> and their verse texts<br/>
              &#x2022; All <strong style={{color:'#f08080'}}>{sectionCount} {sectionCount===1?'section':'sections'}</strong><br/>
              &#x2022; All <strong style={{color:'#f08080'}}>bookmarks</strong> and <strong style={{color:'#f08080'}}>reading history</strong><br/>
              &#x2022; All <strong style={{color:'#f08080'}}>version settings</strong> (uploaded CSVs remain in your account)<br/>
              &#x2022; All <strong style={{color:'#f08080'}}>display preferences</strong> (theme, hidden versions, filters)
            </div>
          </div>
          <div style={{background:'#0a1a0a',border:'1px solid #2a4a2a',borderRadius:8,padding:'14px 18px',marginBottom:22}}>
            <div style={{fontFamily:FS,fontSize:9.5,letterSpacing:'0.12em',textTransform:'uppercase',color:'#62c484',marginBottom:8,fontWeight:600}}>The app will be restored to:</div>
            <div style={{fontFamily:FB,fontSize:14,color:'#7ab890',lineHeight:1.9}}>
              KJV + RVG versions &nbsp;&#xB7;&nbsp; 2 default sections &nbsp;&#xB7;&nbsp; Genesis 1:1 and John 3:16 sample entries &nbsp;&#xB7;&nbsp; Dark mode
            </div>
          </div>
          <div style={{marginBottom:6}}>
            <div style={{fontFamily:FS,fontSize:9.5,color:'#c09090',letterSpacing:'0.1em',marginBottom:8,fontWeight:500}}>
              Type <strong style={{color:'#f08080',letterSpacing:'0.16em'}}>RESET</strong> to confirm:
            </div>
            <input
              value={typed}
              onChange={e=>setTyped(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter'&&ready)onConfirm();}}
              placeholder="Type RESET here..."
              autoFocus
              style={{width:'100%',background:'#0e0505',border:`2px solid ${ready?'#c83030':'#4a1a1a'}`,borderRadius:6,color:'#f08080',fontFamily:FS,fontSize:14,letterSpacing:'0.12em',padding:'10px 14px',outline:'none',transition:'border-color .2s',boxSizing:'border-box'}}
            />
          </div>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'18px 30px 24px',background:'rgba(0,0,0,0.25)',borderTop:'1px solid #3a1010'}}>
          <SBtn ch="Cancel — Keep My Data" onClick={onCancel} T={T}/>
          <button
            onClick={()=>{if(ready)onConfirm();}}
            disabled={!ready}
            style={{background:ready?'#8a1010':'#2a0808',border:`1px solid ${ready?'#c83030':'#4a1414'}`,borderRadius:6,color:ready?'#f08080':'#5a2020',fontFamily:FS,fontSize:9.5,letterSpacing:'0.12em',textTransform:'uppercase',padding:'9px 20px',fontWeight:700,cursor:ready?'pointer':'default',opacity:ready?1:.5,transition:'all .2s'}}>
            &#9888; Reset Everything
          </button>
        </div>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════
function App(){
  // ── Auth ──
  const[user,setUser]=useState(null);
  const[authChecked,setAuthChecked]=useState(false);
  const[authWelcome,setAuthWelcome]=useState(false);
  const[recoveryMode,setRecoveryMode]=useState(false);

  // ── Project ──
  const[projectId,setProjectId]=useState(null);
  const[data,setData]=useState(null);
  const[ready,setReady]=useState(false);
  const[loadMsg,setLoadMsg]=useState('');
  const[saveStatus,setSaveStatus]=useState('saved');

  // ── UI ──
  const[dark,setDark]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:dark')|| 'true');}catch{return true;}});
  const[accent,setAccent]=useState(()=>{try{return localStorage.getItem('scrip:accent')||'gold';}catch{return 'gold';}});
  const[tab,setTab]=useState('read'); // 'read'|'study'|'parallel'|'compare'|'strongs'|'dictionary'
  const[q,setQ]=useState('');
  const[filters,setFilters]=useState({issueTypes:[],statuses:[],vA:'',vB:''});
  const[hiddenVers,setHiddenVers]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:hidden')||'[]');}catch{return[];}});
  const[modal,setModal]=useState(null);
  const[undo,setUndo]=useState(null);
  const[pulseId,setPulseId]=useState(null);
  const[secToggle,setSecToggle]=useState(null);
  const[mobileSheet,setMobileSheet]=useState(null);
  const[mobileSheetClosing,setMobileSheetClosing]=useState(false);
  function closeMobileSheet(){setMobileSheetClosing(true);setTimeout(()=>{setMobileSheet(null);setMobileSheetClosing(false);},260);}
  const[readSheetClosing,setReadSheetClosing]=useState(false);
  function closeReadSheet(){setReadSheetClosing(true);setTimeout(()=>{setReadMobileSheet(null);setReadSheetClosing(false);},260);}

  // ── Reading state (persistent in tab, not modal) ──
  const[readBook,setReadBook]=useState(()=>{try{return Number(localStorage.getItem('scrip:readBook'))||1;}catch{return 1;}});
  const[readCh,setReadCh]=useState(()=>{try{return Number(localStorage.getItem('scrip:readCh'))||1;}catch{return 1;}});
  const[readVid,setReadVid]=useState(null); // set after data loads
  const[readVerses,setReadVerses]=useState([]);
  const[readSelVerses,setReadSelVerses]=useState(()=>new Set()); // multi-select
  const[stripOpen,setStripOpen]=useState(false);
  const[stripClosing,setStripClosing]=useState(false);
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
  const wasTouchEvent=useRef(false);
  const verseTouchStartY=useRef(0);
  const verseTouchScrolled=useRef(false);
  const readScrollToVerse=useRef(null);
  function dismissStrip(){setStripClosing(true);setTimeout(()=>{setReadSelVerses(new Set());setStripOpen(false);setStripClosing(false);},160);}
  function openStrip(v){if(readFullScreen.current)exitFullScreen();setReadSelVerses(s=>{const ns=new Set(s);ns.add(v);return ns;});setStripOpen(true);}
  function verseTouchStart(v,e){longPressFired.current=false;wasTouchEvent.current=true;verseTouchScrolled.current=false;verseTouchStartY.current=e.touches[0].clientY;longPressTimer.current=setTimeout(()=>{longPressFired.current=true;longPressTimer.current=null;openStrip(v);},500);}
  function verseTouchMove(e){if(Math.abs(e.touches[0].clientY-verseTouchStartY.current)>8){verseTouchScrolled.current=true;if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}}}
  function handleVerseToggle(v){const willEmpty=readSelVerses.has(v)&&readSelVerses.size===1;setReadSelVerses(s=>{const ns=new Set(s);ns.has(v)?ns.delete(v):ns.add(v);return ns;});if(willEmpty&&stripOpen)dismissStrip();}
  function verseTouchEnd(v){if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}if(!longPressFired.current&&!verseTouchScrolled.current){handleVerseToggle(v);}setTimeout(()=>{wasTouchEvent.current=false;},300);}
  function verseClick(v,dbl=false){if(wasTouchEvent.current)return;if(readFullScreen.current)exitFullScreen();if(dbl){openStrip(v);}else{handleVerseToggle(v);}}
  const[readBmLabel,setReadBmLabel]=useState('');
  const[readBmOk,setReadBmOk]=useState(false);
  const[readCopyOk,setReadCopyOk]=useState(false);
  const[readSearchQ,setReadSearchQ]=useState('');
  const[readSearchRes,setReadSearchRes]=useState(null);
  const[readSearchOccurrences,setReadSearchOccurrences]=useState(0);
  const[readSearchLimit,setReadSearchLimit]=useState(50);
  const[readSearching,setReadSearching]=useState(false);
  const[searchOpts,setSearchOpts]=useState({scope:'all',mode:'all',caseSensitive:false,partial:false});
  const SEARCH_DEFAULTS={scope:'all',mode:'all',caseSensitive:false,partial:false};
  const[recentSearches,setRecentSearches]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip_recent_searches')||'[]');}catch{return[];}});
  const[readSearchPopover,setReadSearchPopover]=useState(false);
  const[readMobileSheet,setReadMobileSheet]=useState(null); // 'nav'|'version'|'search'|'settings'
  const[navStep,setNavStep]=useState('book'); // 'book'|'chapter'|'verse'
  const[navPickedBk,setNavPickedBk]=useState(null);
  const[navPickedCh,setNavPickedCh]=useState(null);
  const navContentRef=useRef(null);
  const[navSheetH,setNavSheetH]=useState(null);
  useEffect(()=>{
    if(readMobileSheet!=='nav')return;
    requestAnimationFrame(()=>{
      if(navContentRef.current){
        const h=navContentRef.current.scrollHeight+8+32; // content + top/bottom padding
        const maxH=window.innerHeight-navH-50;
        setNavSheetH(Math.min(h,maxH));
      }
    });
  },[navStep,navPickedBk,navPickedCh,readMobileSheet]);
  const[settingsAppOpen,setSettingsAppOpen]=useState(false);
  const[readFontSize,setReadFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:fontSize'))||31;}catch{return 31;}});
  const[parallelFontSize,setParallelFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:parallelFontSize'))||16;}catch{return 16;}});
  const[readLineHeight,setReadLineHeight]=useState(()=>{try{return Number(localStorage.getItem('scrip:lineHeight'))||1.2;}catch{return 1.2;}});
  const[readFontFamily,setReadFontFamily]=useState(()=>{try{return localStorage.getItem('scrip:fontFamily')||'serif';}catch{return 'serif';}});
  const[readVerseNums,setReadVerseNums]=useState(()=>{try{return localStorage.getItem('scrip:verseNums')||'super';}catch{return 'super';}});
  const[readTextAlign,setReadTextAlign]=useState(()=>{try{return localStorage.getItem('scrip:textAlign')||'left';}catch{return 'left';}});
  const[readParaMode,setReadParaMode]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:paraMode'))===true;}catch{return false;}});
  const[readRedLetter,setReadRedLetter]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:redLetter'))===true;}catch{return false;}});
  const[readAutoFullscreen,setReadAutoFullscreen]=useState(()=>{try{const v=localStorage.getItem('scrip:autoFullscreen');return v===null?true:JSON.parse(v)===true;}catch{return true;}});
  const readFullScreen=useRef(false);
  const fsTransitioning=useRef(false);
  const bottomBarRef=useRef(null);
  const headerAnimRef=useRef(null);
  const bottomAnimRef=useRef(null);
  function enterFullScreen(){
    if(readFullScreen.current||fsTransitioning.current)return;
    readFullScreen.current=true;fsTransitioning.current=true;
    if(headerAnimRef.current){headerAnimRef.current.cancel();headerAnimRef.current=null;}
    if(bottomAnimRef.current){bottomAnimRef.current.cancel();bottomAnimRef.current=null;}
    const h=navRef.current,b=bottomBarRef.current;
    if(h)headerAnimRef.current=h.animate([{transform:'translateY(0)'},{transform:'translateY(-100%)'}],{duration:180,easing:'ease-in',fill:'forwards'});
    if(b)bottomAnimRef.current=b.animate([{transform:'translateY(0)'},{transform:'translateY(100%)'}],{duration:180,easing:'ease-in',fill:'forwards'});
    setTimeout(()=>{fsTransitioning.current=false;},180);
  }
  function exitFullScreen(){
    if(!readFullScreen.current||fsTransitioning.current)return;
    readFullScreen.current=false;fsTransitioning.current=true;
    if(headerAnimRef.current){headerAnimRef.current.cancel();headerAnimRef.current=null;}
    if(bottomAnimRef.current){bottomAnimRef.current.cancel();bottomAnimRef.current=null;}
    const h=navRef.current,b=bottomBarRef.current;
    if(h){const a=h.animate([{transform:'translateY(-100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>a.cancel();}
    if(b){const a=b.animate([{transform:'translateY(100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>a.cancel();}
    setTimeout(()=>{fsTransitioning.current=false;},180);
  }
  const lastScrollY=useRef(0);
  const scrollDelta=useRef(0);
  const fsScrollThreshold=30;
  const scrollbarThumbRef=useRef(null);
  const scrollbarHideTimer=useRef(null);
  const scrollRafPending=useRef(false);
  const scrollPendingState=useRef(null);
  function handleReadScroll(e){
    if(readSearchRes){if(readFullScreen.current)exitFullScreen();scrollDelta.current=0;return;}
    const el=e.target;const sy=el.scrollTop;const dy=sy-lastScrollY.current;lastScrollY.current=sy;
    // Fullscreen logic runs immediately (no RAF needed — it doesn't touch layout)
    if(sy<=5){if(readFullScreen.current)exitFullScreen();scrollDelta.current=0;}
    else{
      if(Math.sign(dy)!==Math.sign(scrollDelta.current))scrollDelta.current=0;
      scrollDelta.current+=dy;
      if(scrollDelta.current>fsScrollThreshold&&!readFullScreen.current){if(readAutoFullscreen)enterFullScreen();scrollDelta.current=0;}
      else if(scrollDelta.current<-fsScrollThreshold&&readFullScreen.current){exitFullScreen();scrollDelta.current=0;}
    }
    // Scrollbar DOM updates — throttled to once per animation frame
    if(!scrollbarThumbRef.current)return;
    scrollPendingState.current={el,sy};
    if(scrollRafPending.current)return;
    scrollRafPending.current=true;
    requestAnimationFrame(()=>{
      scrollRafPending.current=false;
      const{el,sy}=scrollPendingState.current||{};
      if(!el||!scrollbarThumbRef.current)return;
      const totalH=el.scrollHeight;const viewH=el.clientHeight;
      if(totalH>viewH){
        const trackTop=navH;
        const trackBottom=window.innerHeight-(bottomBarRef.current?.offsetHeight||40);
        const trackH=trackBottom-trackTop;
        const thumbH=Math.max(32,trackH*(viewH/totalH));
        const maxTravel=trackH-thumbH;
        const top=trackTop+sy/(totalH-viewH)*maxTravel;
        scrollbarThumbRef.current.style.top=top+'px';
        scrollbarThumbRef.current.style.height=thumbH+'px';
        scrollbarThumbRef.current.classList.add('visible');
        clearTimeout(scrollbarHideTimer.current);
        scrollbarHideTimer.current=setTimeout(()=>{scrollbarThumbRef.current&&scrollbarThumbRef.current.classList.remove('visible');},900);
      }
    });
  }
  const[strongsMode,setStrongsMode]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:strongsMode'))||false;}catch{return false;}});
  const[strongsData,setStrongsData]=useState({}); // {verse: [{word_pos,word_text,strongs_num}]}
  const[strongsPopup,setStrongsPopup]=useState(null); // {strongs_number,word_text,entry:{...},verses:[],versesLoading:bool}
  const[strongsClosing,setStrongsClosing]=useState(false);
  function closeStrongsPopup(){setStrongsClosing(true);setTimeout(()=>{setStrongsPopup(null);setStrongsVersePreview(null);setStrongsClosing(false);},250);}
  const[strongsLoading,setStrongsLoading]=useState(false);
  const[strongsExpandedWords,setStrongsExpandedWords]=useState(()=>new Set());
  const[strongsVersePreview,setStrongsVersePreview]=useState(null); // {bn,ch,vs,label,text,loading}
  const[strongsInfoVisible,setStrongsInfoVisible]=useState(false);
  // Strong's tab search state (must be at component level for hooks)
  const[strongsSearchQ,setStrongsSearchQ]=useState('');
  const[strongsSearchRes,setStrongsSearchRes]=useState(null);
  const[strongsSearchLoading,setStrongsSearchLoading]=useState(false);
  const[strongsTabEntry,setStrongsTabEntry]=useState(null);
  const strongsSearchTimer=useRef(null);

  // ── Local download state per version {downloaded,downloading,progress,total,err} ──
  const[dlStates,setDlStates]=useState({});
  const dlAbort=useRef({});

  useEffect(()=>{
    // Check which versions + datasets are already in IndexedDB
    (async()=>{
      const ids=[...PUBLIC_VERSIONS.map(pv=>pv.id),'strongs','webster'];
      const checks=await Promise.all(ids.map(async id=>({id,downloaded:await idbIsDownloaded(id).catch(()=>false)})));
      const map={};for(const c of checks)map[c.id]={downloaded:c.downloaded};
      setDlStates(map);
    })();
  },[]);

  function setDlState(vid,patch){setDlStates(prev=>({...prev,[vid]:{...(prev[vid]||{}), ...patch}}));}

  async function startDownload(vid){
    if(dlAbort.current[vid])dlAbort.current[vid].abort();
    const ctrl=new AbortController();
    dlAbort.current[vid]=ctrl;
    const initTotal=vid==='strongs'?14197:vid==='webster'?107793:31102;
    setDlState(vid,{downloading:true,downloaded:false,progress:0,total:initTotal,err:null});
    try{
      const progressCb=(done,total)=>setDlState(vid,{downloading:true,progress:done,total});
      if(vid==='strongs')await downloadStrongsLocally(progressCb,ctrl.signal);
      else if(vid==='webster')await downloadWebsterLocally(progressCb,ctrl.signal);
      else await downloadVersionLocally(vid,progressCb,ctrl.signal);
      setDlState(vid,{downloaded:true,downloading:false,progress:0,total:0});
    }catch(e){
      if(e.name!=='AbortError')setDlState(vid,{downloading:false,err:e.message||'Download failed'});
      else setDlState(vid,{downloading:false});
    }finally{delete dlAbort.current[vid];}
  }

  async function deleteDownload(vid){
    if(vid==='strongs'){await idbClearStrongs().catch(()=>{});await idbPutMeta('dl:strongs',false);}
    else if(vid==='webster'){await idbClearWebster().catch(()=>{});await idbPutMeta('dl:webster',false);}
    else await idbDeleteVersionLocal(vid).catch(()=>{});
    setDlState(vid,{downloaded:false,downloading:false});
  }

  const[readSettingsOpen,setReadSettingsOpen]=useState(false);
  const readRef=useRef(null);
  const scrollHandlerRef=useRef(null);
  const loadMorePendingRef=useRef(false);
  const navRef=useRef(null);
  const [navH,setNavH]=useState(0);
  const swipeTouchX=useRef(null);
  const swipeTouchY=useRef(null);
  const swipeTouchT=useRef(null);
  const swipeDir=useRef(null); // null|'h'|'v'
  const readSearchJumpTo=useRef(null);

  // ── Parallel Verses state ──
  const[parallelVids,setParallelVids]=useState([]);
  const[parallelBk,setParallelBk]=useState(1);
  const[parallelCh,setParallelCh]=useState(1);
  const[parallelVs,setParallelVs]=useState(1);
  const[parallelChapters,setParallelChapters]=useState({});
  const[parallelLoading,setParallelLoading]=useState(false);
  const[parallelMobileSheet,setParallelMobileSheet]=useState(null);

  // ── Dictionary state ──
  const[dictSearchQ,setDictSearchQ]=useState('');
  const[dictDbEntries,setDictDbEntries]=useState(null); // [{word,pos,definitions}]
  const[dictDbLoading,setDictDbLoading]=useState(false);
  const[dictLive,setDictLive]=useState(null); // external API fallback
  const[dictLiveLoading,setDictLiveLoading]=useState(false);
  const dictTimerRef=useRef(null);

  // ── Bookmarks / Recents ──
  const[bookmarks,setBookmarks]=useState([]);
  const[recents,setRecents]=useState([]);

  const undoTRef=useRef(null);const undoPRef=useRef(null);
  const _acc=(ACCENTS[accent]||ACCENTS.gold)[dark?'dark':'light'];
  const T={...(dark?D:L),..._acc,accentLine:`linear-gradient(90deg,transparent,${_acc.gD},${_acc.g},${_acc.gD},transparent)`};

  // ── CSS variable accent injection ──
  useEffect(()=>{
    function hexToRgb(h){const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return`${r},${g},${b}`;}
    const rgb=hexToRgb(T.g||'#c8a84e');
    const rgbD=hexToRgb(T.gD||'#4a3e22');
    const r=document.getElementById('accent-vars')||Object.assign(document.createElement('style'),{id:'accent-vars'});
    r.textContent=`:root{--ac-scrollbar:${T.gD};--ac-mark:rgba(${rgb},0.22);--ac-bd:${T.gD};--ac-ghost-bg:rgba(${rgb},0.09);--ac-ghost-bd:rgba(${rgb},0.3);--ac-tbtn-bd:rgba(${rgb},0.5);--ac-tbtn-bg:rgba(${rgb},0.06);--ac-focus:rgba(${rgb},0.4);--ac-pulse0:rgba(${rgb},0);--ac-pulse50:rgba(${rgb},0.25);--ac-shimmer:rgba(${rgb},0.12);--ac-spin-ring:rgba(${rgb},0.2);--ac-spin-top:${T.g};--ac-verse-hover:rgba(${rgb},0.05);--ac-input-bd:rgba(${rgb},0.27);--ac-input-sh:rgba(${rgb},0.08);}`;
    if(!r.parentNode)document.head.appendChild(r);
  },[T.g,T.gD]);

  // ── Persist prefs ──
  useEffect(()=>{localStorage.setItem('scrip:dark',JSON.stringify(dark));},[dark]);
  useEffect(()=>{try{localStorage.setItem('scrip:accent',accent);}catch{}},[accent]);
  useEffect(()=>{localStorage.setItem('scrip:hidden',JSON.stringify(hiddenVers));},[hiddenVers]);
  useEffect(()=>{try{localStorage.setItem('scrip:readBook',readBook);localStorage.setItem('scrip:readCh',readCh);}catch{}},[readBook,readCh]);
  // ── Sync body background with theme ──
  useEffect(()=>{document.body.style.background=T.bg;},[T.bg]);
  useEffect(()=>{
    const measure=()=>{if(navRef.current)setNavH(navRef.current.offsetHeight);};
    measure();
    const ro=new ResizeObserver(measure);
    if(navRef.current)ro.observe(navRef.current);
    window.addEventListener('resize',measure);
    return()=>{ro.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  // Re-measure nav height after loading completes (navRef is null during loading screen)
  useEffect(()=>{if(ready&&navRef.current)setNavH(navRef.current.offsetHeight);},[ready]);
  // ── Dictionary lookup (local IndexedDB → Supabase RPC → external API) ──
  useEffect(()=>{
    if(dictTimerRef.current)clearTimeout(dictTimerRef.current);
    const q=dictSearchQ.trim().toLowerCase();
    if(!q||q.length<2){setDictDbEntries(null);setDictDbLoading(false);setDictLive(null);setDictLiveLoading(false);return;}
    setDictDbLoading(true);setDictLive(null);setDictLiveLoading(false);
    dictTimerRef.current=setTimeout(async()=>{
      try{
        // Local-first: check IndexedDB
        let r=null;
        try{
          if(await idbIsDownloaded('webster')){
            const local=await idbSearchWebsterLocal(q);
            if(local.length>0){setDictDbEntries(local);setDictDbLoading(false);return;}
            r=[];
          }
        }catch{}
        // Network fallback
        if(r===null){
          const{data}=await sbRpc('search_webster_1828',{query_term:q});
          r=Array.isArray(data)?data:[];
        }
        if(r.length>0){setDictDbEntries(r);setDictDbLoading(false);return;}
        setDictDbEntries(null);setDictDbLoading(false);
        // No Webster results — try external API fallback
        setDictLiveLoading(true);
        try{
          const lr=await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`);
          if(lr.ok){const d=await lr.json();setDictLive(Array.isArray(d)&&d.length?d:null);}
          else setDictLive(null);
        }catch{setDictLive(null);}
        setDictLiveLoading(false);
      }catch{setDictDbEntries(null);setDictDbLoading(false);}
    },300);
  },[dictSearchQ]);
  // ── Jump-To scroll: fires after readSearchLimit extends ──
  useEffect(()=>{
    if(!readSearchJumpTo.current)return;
    const el=document.getElementById('srch-bk-'+readSearchJumpTo.current);
    if(el){el.scrollIntoView({behavior:'smooth',block:'start'});readSearchJumpTo.current=null;}
  },[readSearchLimit]);

  // ── Auth init — process email link hash params first ──
  useEffect(()=>{
    const hash=window.location.hash.substring(1);
    if(hash){
      const p=Object.fromEntries(new URLSearchParams(hash));
      if(p.access_token){
        const session={access_token:p.access_token,refresh_token:p.refresh_token||'',expires_in:parseInt(p.expires_in||3600),expires_at:Math.floor(Date.now()/1000)+parseInt(p.expires_in||3600),token_type:p.token_type||'bearer'};
        localStorage.setItem(SB_KEY,JSON.stringify(session));
        history.replaceState(null,'',window.location.pathname);
        if(p.type==='signup')setAuthWelcome(true);
        if(p.type==='recovery')setRecoveryMode(true);
      }
    }
    Auth.getSession().then(s=>{setUser(s?.user||null);setAuthChecked(true);});
    return Auth.onAuthChange(u=>{setUser(u||null);if(!u){setData(null);setReady(false);setProjectId(null);}});
  },[]);

  // ── Load project on auth ──
  useEffect(()=>{
    if(!user)return;
    // Guest mode: skip Supabase, use in-memory defaults
    if(user.guest){
      const pd={versions:PUBLIC_VERSIONS,sections:[],entries:[]};
      setProjectId('guest-local');
      setData(pd);
      setReadVid(PUBLIC_VERSIONS.find(v=>v.isRef)?.id||PUBLIC_VERSIONS[0]?.id||'kjv');
      setParallelVids(PUBLIC_VERSIONS.map(v=>v.id));
      setBookmarks([]);setRecents([]);
      setLoadMsg('');setReady(true);
      return;
    }
    (async()=>{
      setReady(false);setLoadMsg('Loading project…');
      const proj=await dbLoadOrCreateProject(user.id);
      if(!proj){setLoadMsg('Could not load project. Check network.');return;}
      setProjectId(proj.id);
      setLoadMsg('Loading study data…');
      const pd=await dbLoadProject(proj.id);
      if(!pd.versions.length){
        setLoadMsg('Setting up versions…');
        await dbSaveVersions(proj.id,PUBLIC_VERSIONS);
        pd.versions=PUBLIC_VERSIONS;
      }
      // Seed default sections + sample entries for brand-new users
      if(pd.sections.length===0&&pd.entries.length===0){
        setLoadMsg('Preparing starter content…');
        const s1id=await dbSaveSection({title:'§ I — Default Section',description:'Starting point for your study. Edit or delete freely.',_isNew:true},proj.id);
        const s2id=await dbSaveSection({title:'§ II — Default Section',description:'',_isNew:true},proj.id);
        const refVid=pd.versions.find(v=>v.isRef)?.id||pd.versions[0]?.id||'kjv';
        const g11texts=await dbAutoFill(1,1,1,pd.versions.map(v=>v.id));
        const j316texts=await dbAutoFill(43,3,16,pd.versions.map(v=>v.id));
        // Hardcoded fallbacks so entries always have verse text even if DB auto-fill is slow
        const G11_FALLBACK={kjv:'In the beginning God created the heaven and the earth.',rvg:'En el principio creó Dios los cielos y la tierra.'};
        const J316_FALLBACK={kjv:'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',rvg:'Porque de tal manera amó Dios al mundo, que ha dado a su Hijo unigénito, para que todo aquel que en él cree, no se pierda, mas tenga vida eterna.'};
        const vdata1={};for(const v of pd.versions){const txt=g11texts[v.id]||G11_FALLBACK[v.id]||'';if(txt)vdata1[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
        const vdata2={};for(const v of pd.versions){const txt=j316texts[v.id]||J316_FALLBACK[v.id]||'';if(txt)vdata2[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
        const e1={id:genId(),sectionId:s1id,reference:'Genesis 1:1',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:vdata1,_isNew:true};
        const e2={id:genId(),sectionId:s2id,reference:'John 3:16',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:vdata2,_isNew:true};
        await dbSaveEntry(e1,proj.id);
        await dbSaveEntry(e2,proj.id);
        const pd2=await dbLoadProject(proj.id);
        setData(pd2);
      }else{
        setData(pd);
      }
      setReadVid(pd.versions.find(v=>v.isRef)?.id||pd.versions[0]?.id||'kjv');
      setParallelVids(pd.versions.map(v=>v.id));
      setLoadMsg('');setReady(true);
      dbLoadBookmarks(user.id).then(setBookmarks);
      dbLoadRecents(user.id).then(setRecents);
    })();
  },[user]);

  // ── Load reading chapter ──
  useEffect(()=>{
    if(!readVid||!ready)return;
    let cancelled=false;
    setReadSelVerses(new Set());setReadSearchRes(null);
    dbGetChapter(readVid,readBook,readCh).then(rows=>{
      if(!cancelled){
        setReadVerses(rows);
        if(readScrollToVerse.current){const tv=readScrollToVerse.current;readScrollToVerse.current=null;setTimeout(()=>{const el=document.getElementById(`rv-${tv}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(tv);return ns;});},80);}
        else{readRef.current?.scrollTo({top:0,behavior:'instant'});}
      }
      if(user&&!user.guest&&!cancelled)dbRecordRecent(user.id,readVid,readBook,readCh).catch(()=>{});
    }).catch(()=>{
      if(!cancelled)setReadVerses([]);
    });
    return()=>{cancelled=true;};
  },[readVid,readBook,readCh,ready]);

  // ── Persist Strong's mode ──
  useEffect(()=>{localStorage.setItem('scrip:strongsMode',JSON.stringify(strongsMode));},[strongsMode]);

  // ── Load Strong's data for current chapter ──
  useEffect(()=>{
    if(!strongsMode||!ready||readVid!=='kjv'){setStrongsData(d=>Object.keys(d).length?{}:d);return;}
    let cancelled=false;
    setStrongsLoading(true);
    dbGetStrongsForChapter(readBook,readCh).then(rows=>{
      if(cancelled)return;
      // Group by verse
      const byVerse={};
      for(const r of rows){
        if(!byVerse[r.verse])byVerse[r.verse]=[];
        byVerse[r.verse].push(r);
      }
      setStrongsData(byVerse);
      setStrongsLoading(false);
    }).catch(()=>{if(!cancelled){setStrongsData({});setStrongsLoading(false);}});
    return()=>{cancelled=true;};
  },[strongsMode,readBook,readCh,ready,readVid]);

  // ── Native passive scroll listener (avoids non-passive React onScroll blocking compositor) ──
  useEffect(()=>{
    const el=readRef.current;
    if(!el)return;
    function handler(){scrollHandlerRef.current&&scrollHandlerRef.current(el);}
    el.addEventListener('scroll',handler,{passive:true});
    return()=>el.removeEventListener('scroll',handler);
  },[ready,tab]); // re-attach when ready or tab changes; handler ref stays fresh every render

  // ── Strong's word tap handler ──
  const strongsCache=useRef({});
  async function fetchStrongsData(strongsNum){
    if(strongsCache.current[strongsNum])return strongsCache.current[strongsNum];
    const[entry,verses]=await Promise.all([dbGetStrongsEntry(strongsNum),dbGetStrongsVerses(strongsNum)]);
    strongsCache.current[strongsNum]={entry,verses};
    return{entry,verses};
  }
  async function handleStrongsWordTap(strongsNum,wordText){
    setStrongsExpandedWords(new Set());
    const cached=strongsCache.current[strongsNum];
    if(cached){
      setStrongsPopup({strongs_number:strongsNum,word_text:wordText,entry:cached.entry,verses:cached.verses,versesLoading:false,history:[]});
      return;
    }
    setStrongsPopup({strongs_number:strongsNum,word_text:wordText,entry:null,verses:null,versesLoading:true,history:[]});
    const{entry,verses}=await fetchStrongsData(strongsNum);
    setStrongsPopup(prev=>prev&&prev.strongs_number===strongsNum?{...prev,entry,verses,versesLoading:false}:prev);
  }
  async function loadStrongsEntry(strongsNum){
    setStrongsExpandedWords(new Set());
    setStrongsVersePreview(null);
    const cached=strongsCache.current[strongsNum];
    setStrongsPopup(prev=>{
      if(!prev)return null;
      const histEntry={strongs_number:prev.strongs_number,entry:prev.entry,verses:prev.verses};
      const next={...prev,strongs_number:strongsNum,history:[...(prev.history||[]),histEntry]};
      if(cached)return{...next,entry:cached.entry,verses:cached.verses,versesLoading:false};
      return{...next,entry:null,verses:null,versesLoading:true};
    });
    if(!cached){
      const{entry,verses}=await fetchStrongsData(strongsNum);
      setStrongsPopup(prev=>prev&&prev.strongs_number===strongsNum?{...prev,entry,verses,versesLoading:false}:prev);
    }
  }
  function goBackStrongs(){
    setStrongsExpandedWords(new Set());
    setStrongsVersePreview(null);
    setStrongsPopup(prev=>{
      if(!prev||!prev.history||prev.history.length===0)return prev;
      const history=[...prev.history];
      const last=history.pop();
      return{...prev,...last,history,versesLoading:false};
    });
  }
  async function openStrongsVersePreview(bn,ch,vs){
    const bk=BIBLE[bn-1]?.name||'';
    const label=`${bk} ${ch}:${vs}`;
    setStrongsVersePreview({bn,ch,vs,label,text:null,loading:true});
    try{
      const rows=await dbGetChapter(readVid,bn,ch);
      const row=rows.find(r=>r.verse===vs);
      setStrongsVersePreview(p=>p&&p.bn===bn&&p.ch===ch&&p.vs===vs?{...p,text:row?row.text:'(verse not found)',loading:false}:p);
    }catch{
      setStrongsVersePreview(p=>p&&p.bn===bn&&p.ch===ch&&p.vs===vs?{...p,text:'(could not load)',loading:false}:p);
    }
  }

  // ── Load parallel chapters ──
  useEffect(()=>{
    if(!parallelVids.length||!ready)return;
    let cancelled=false;
    setParallelLoading(true);
    Promise.all(parallelVids.map(vid=>dbGetChapter(vid,parallelBk,parallelCh))).then(results=>{
      if(!cancelled){
        const map={};parallelVids.forEach((vid,i)=>{map[vid]=results[i]||[];});
        setParallelChapters(map);setParallelLoading(false);
      }
    }).catch(()=>{if(!cancelled)setParallelLoading(false);});
    return()=>{cancelled=true;};
  },[parallelVids,parallelBk,parallelCh,ready]);

  // ── Keyboard shortcuts ──
  useEffect(()=>{
    const h=e=>{
      if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();doUndo();return;}
      if(e.key==='Escape')setModal(null);
    };
    window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h);
  },[undo]);

  // ── Undo ──
  function showUndo(label,snap){
    if(undoTRef.current){clearTimeout(undoTRef.current);clearInterval(undoPRef.current);}
    const start=Date.now();const dur=8000;const snapshot=clone(snap);
    setUndo({label,snapshot,pct:100});
    undoPRef.current=setInterval(()=>{const pct=Math.max(0,100-((Date.now()-start)/dur)*100);setUndo(u=>u?{...u,pct}:null);if(Date.now()-start>=dur)dismissUndo();},80);
    undoTRef.current=setTimeout(dismissUndo,dur);
  }
  function dismissUndo(){clearTimeout(undoTRef.current);clearInterval(undoPRef.current);setUndo(null);}
  function doUndo(){if(!undo)return;setData(clone(undo.snapshot));dismissUndo();}

  // ── Filter (Compare tab) ──
  function getFiltered(){
    if(!data)return[];let entries=data.entries;
    if(filters.vA&&filters.vB)entries=entries.filter(e=>{const a=e.versions?.[filters.vA];const b=e.versions?.[filters.vB];return a&&b&&a.status!==b.status;});
    if(filters.issueTypes.length)entries=entries.filter(e=>filters.issueTypes.includes(e.issueType));
    if(filters.statuses.length)entries=entries.filter(e=>Object.values(e.versions||{}).some(v=>filters.statuses.includes(v.status)));
    if(q){const lq=q.toLowerCase();entries=entries.filter(e=>[e.reference,e.issueLabel,e.notes,e.greekHebrew,e.sourceRefs,...Object.values(e.versions||{}).map(v=>v.text)].join(' ').toLowerCase().includes(lq));}
    return entries;
  }
  const hasFilter=!!(filters.issueTypes.length||filters.statuses.length||(filters.vA&&filters.vB)||q);

  function scrollTo(ref){
    const entry=data?.entries.find(e=>e.reference===ref);if(!entry)return;
    setTimeout(()=>{const el=document.getElementById(`card-${entry.id}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setPulseId(entry.id);setTimeout(()=>setPulseId(null),1600);}},50);
  }

  // ── Search infinite scroll ──
  function onSearchScroll(el){
    if(readSearchRes&&readSearchLimit<readSearchRes.length&&el.scrollHeight-el.scrollTop-el.clientHeight<500&&!loadMorePendingRef.current){
      loadMorePendingRef.current=true;
      setReadSearchLimit(n=>{loadMorePendingRef.current=false;return n+50;});
    }
  }

  // ── Keep scroll handler ref fresh every render ──
  scrollHandlerRef.current=(el)=>{
    onSearchScroll(el);
    if(tab==='read')handleReadScroll({target:el});
  };

  // ── Reading helpers ──
  const readBk=BIBLE.find(b=>b.n===readBook);const readTotalCh=readBk?.v?.length||1;
  const readVerLabel=data?.versions.find(v=>v.id===readVid)?.label||readVid?.toUpperCase()||'';
  function readPrevCh(){if(readCh>1)setReadCh(c=>c-1);else if(readBook>1){const nb=readBook-1;setReadBook(nb);setReadCh(BIBLE.find(b=>b.n===nb)?.v?.length||1);}}
  function readNextCh(){if(readCh<readTotalCh)setReadCh(c=>c+1);else if(readBook<66){setReadBook(b=>b+1);setReadCh(1);}}
  // ── Parallel helpers ──
  const parallelBkData=BIBLE.find(b=>b.n===parallelBk);
  const parallelTotalCh=parallelBkData?.v?.length||1;
  const parallelTotalVs=parallelBkData?.v?.[parallelCh-1]||1;
  function parallelPrevVs(){
    if(parallelVs>1){setParallelVs(v=>v-1);return;}
    if(parallelCh>1){const pv=BIBLE.find(b=>b.n===parallelBk)?.v?.[parallelCh-2]||1;setParallelCh(c=>c-1);setParallelVs(pv);return;}
    if(parallelBk>1){const nb=parallelBk-1;const nd=BIBLE.find(b=>b.n===nb);const lc=nd?.v?.length||1;const lv=nd?.v?.[lc-1]||1;setParallelBk(nb);setParallelCh(lc);setParallelVs(lv);}
  }
  function parallelNextVs(){
    if(parallelVs<parallelTotalVs){setParallelVs(v=>v+1);return;}
    if(parallelCh<parallelTotalCh){setParallelCh(c=>c+1);setParallelVs(1);return;}
    if(parallelBk<66){setParallelBk(b=>b+1);setParallelCh(1);setParallelVs(1);}
  }
  function jumpToFromCard(parsed){setReadBook(parsed.bookNum);setReadCh(parsed.chapter);setTab('read');}
  function openFromBookmark(bm){setModal(null);setReadBook(bm.book_num);setReadCh(bm.chapter);setReadVid(bm.version_id);setTab('read');}
  function openFromRecent(r){setModal(null);setReadBook(r.book_num);setReadCh(r.chapter);setReadVid(r.version_id);setTab('read');}

  async function doReadSearch(overrideQ,overrideOpts){
    const query=(overrideQ!==undefined?overrideQ:readSearchQ).trim();
    if(!query)return;
    if(overrideQ!==undefined)setReadSearchQ(overrideQ);
    setReadSearching(true);setReadSearchRes(null);setReadSearchLimit(50);setReadSearchPopover(false);
    const newRecent=[query,...recentSearches.filter(r=>r!==query)].slice(0,10);
    setRecentSearches(newRecent);
    try{localStorage.setItem('scrip_recent_searches',JSON.stringify(newRecent));}catch{}
    try{
      const opts=overrideOpts||searchOpts;
      const token=getToken();
      const words=query.split(/\s+/).filter(Boolean);
      const cs=opts.caseSensitive;
      const ww=opts.partial===false;
      const bookMin=opts.scope==='nt'?40:1;
      const bookMax=opts.scope==='ot'?39:66;
      const PAGE=900;
      const baseParams=(q)=>({p_version_id:readVid,p_query:q,p_limit:PAGE,p_book_min:bookMin,p_book_max:bookMax,p_case_sensitive:cs,p_whole_word:ww});
      async function fetchAll(q){
        let all=[];let offset=0;
        while(true){
          const{data:res}=await sbRpc('search_verses',{...baseParams(q),p_offset:offset},token);
          if(!Array.isArray(res)||res.length===0)break;
          all=all.concat(res);
          if(res.length<PAGE)break;
          offset+=res.length;
        }
        return all;
      }
      function matches(text){
        const chk=w=>{
          if(opts.partial===false){
            const rx=new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,cs?'':'i');
            return rx.test(text);
          }
          return cs?text.includes(w):text.toLowerCase().includes(w.toLowerCase());
        };
        if(opts.mode==='phrase') return cs?text.includes(query):text.toLowerCase().includes(query.toLowerCase());
        if(opts.mode==='all') return words.every(w=>chk(w));
        return words.some(w=>chk(w));
      }
      let results=[];
      if(opts.mode==='any'&&words.length>1){
        const responses=await Promise.all(words.map(w=>fetchAll(w)));
        const seen=new Set();
        for(const res of responses){
          for(const r of res){
            const k=`${r.book_num}-${r.chapter}-${r.verse}`;
            if(!seen.has(k)){seen.add(k);results.push(r);}
          }
        }
      } else if(opts.mode==='all'&&words.length>1){
        const seed=words.slice().sort((a,b)=>a.length-b.length)[0];
        results=await fetchAll(seed);
      } else {
        results=await fetchAll(query);
      }
      results=results.filter(r=>matches(r.text||''));
      results.sort((a,b)=>a.book_num-b.book_num||a.chapter-b.chapter||a.verse-b.verse);
      // Count total occurrences across all matching verses
      let occ=0;
      const occWords=opts.mode==='phrase'?[query]:words;
      results.forEach(r=>{
        const txt=r.text||'';
        occWords.forEach(w=>{
          const pat=w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
          const bounded=opts.partial===false?`\\b${pat}\\b`:pat;
          const rx=new RegExp(bounded,cs?'g':'gi');
          const m=txt.match(rx);
          if(m)occ+=m.length;
        });
      });
      setReadSearchOccurrences(occ);
      setReadSearchRes(results);
      closeReadSheet();
    }catch(err){
      setReadSearchRes([]);
      closeReadSheet();
    }finally{
      setReadSearching(false);
    }
  }
  async function doReadBookmark(){
    const v=[...readSelVerses].sort((a,b)=>a-b)[0];
    if(!user||!v)return;
    await handleAddBookmark({versionId:readVid,bookNum:readBook,chapter:readCh,verse:v,label:readBmLabel||`${readBk?.name} ${readCh}:${v}`});
    setReadBmOk(true);setTimeout(()=>{setReadBmOk(false);setReadBmLabel('');dismissStrip();},1800);
  }

  async function copySelectedVerses(){
    const sorted=[...readSelVerses].sort((a,b)=>a-b);
    const verseLines=sorted.map(v=>{const row=readVerses.find(r=>r.verse===v);return row?{v,text:row.text.replace(/<[^>]*>/g,'')}:null;}).filter(Boolean);
    if(!verseLines.length)return;
    // Build range header: "Book Ch:V" or "Book Ch:V1-V2" or "Book Ch:V1-V2,V4,V6-V8"
    const bookName=readBk?.name||'';
    const ranges=[];let i=0;
    while(i<sorted.length){let start=sorted[i],end=start;while(i+1<sorted.length&&sorted[i+1]===end+1){i++;end=sorted[i];}ranges.push(start===end?`${start}`:`${start}-${end}`);i++;}
    const header=`${bookName} ${readCh}:${ranges.join(',')}`;
    const sup=n=>[...String(n)].map(c=>'\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079'[c]).join('');
    const body=verseLines.map(({v,text})=>`${sup(v)} ${text}`).join('\n');
    const output=header+'\n'+body;
    try{await navigator.clipboard.writeText(output);}catch{
      const ta=document.createElement('textarea');ta.value=output;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    }
    setReadCopyOk(true);setTimeout(()=>{setReadCopyOk(false);dismissStrip();},1600);
  }

  // ── Entry CRUD ──
  function openAdd(){setModal({type:'entry',entry:{id:genId(),sectionId:data.sections[0]?.id||'',reference:'',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:{},_isNew:true}});}
  function openEdit(id){const e=data.entries.find(x=>x.id===id);if(e)setModal({type:'entry',entry:{...clone(e),_isEdit:true}});}
  function openDup(id){const e=data.entries.find(x=>x.id===id);if(e)setModal({type:'entry',entry:{...clone(e),id:genId(),_isNew:true}});}
  function openDelEntry(id){setModal({type:'delete',delType:'entry',delId:id});}

  async function saveEntry(updated){
    setSaveStatus('saving');
    try{
      const savedId=await dbSaveEntry(updated,projectId);
      const final={...updated,id:savedId||updated.id,_isNew:undefined,_isEdit:undefined};
      setData(d=>{const i=d.entries.findIndex(e=>e.id===updated.id||e.id===final.id);const entries=i>=0?d.entries.map((e,ix)=>ix===i?final:e):[...d.entries,final];return{...d,entries};});
    }catch(err){console.error('saveEntry:',err);}
    setModal(null);setSaveStatus('saved');
  }

  // ── Section CRUD ──
  function openAddSec(){setModal({type:'section',sec:null});}
  function openEditSec(id){const s=data.sections.find(x=>x.id===id);if(s)setModal({type:'section',sec:clone(s)});}
  function openDelSec(id){setModal({type:'delete',delType:'section',delId:id});}

  async function saveSec(sec){
    setSaveStatus('saving');
    try{
      const savedId=await dbSaveSection(sec,projectId);
      const final={...sec,id:savedId,_isNew:undefined};
      setData(d=>{const i=d.sections.findIndex(s=>s.id===sec.id||s.id===savedId);const sections=i>=0?d.sections.map((s,ix)=>ix===i?final:s):[...d.sections,final];return{...d,sections};});
    }catch(err){console.error('saveSec:',err);}
    setModal(null);setSaveStatus('saved');
  }

  async function confirmDel(){
    if(!modal||modal.type!=='delete')return;
    const{delType,delId}=modal;const snap=clone(data);let label='';
    setSaveStatus('saving');
    try{
      if(delType==='entry'){label=data.entries.find(x=>x.id===delId)?.reference||'Entry';await dbDeleteEntry(delId);setData(d=>({...d,entries:d.entries.filter(x=>x.id!==delId)}));}
      else if(delType==='section'){label=data.sections.find(x=>x.id===delId)?.title||'Section';await dbDeleteSection(delId);setData(d=>({...d,sections:d.sections.filter(x=>x.id!==delId)}));}
    }catch(err){console.error('delete:',err);}
    setModal(null);setSaveStatus('saved');showUndo(label,snap);
  }

  async function saveVersions(vers){
    setSaveStatus('saving');
    try{await dbSaveVersions(projectId,vers);setData(d=>({...d,versions:vers}));}
    catch(err){console.error('saveVersions:',err);}
    setModal(null);setSaveStatus('saved');
  }

  async function handleAddBookmark(params){
    if(!user)return;
    if(user.guest){
      // Session-only bookmark for guests
      const bm={id:'g-'+Date.now(),user_id:'guest',version_id:params.versionId,book_num:params.bookNum,chapter:params.chapter,verse:params.verse||null,label:params.label||null,created_at:new Date().toISOString()};
      setBookmarks(b=>[bm,...b]);return;
    }
    const bm=await dbAddBookmark(user.id,params);if(bm)setBookmarks(b=>[bm,...b]);
  }
  async function handleDelBookmark(id){await dbDeleteBookmark(id);setBookmarks(b=>b.filter(x=>x.id!==id));}
  function togVer(vid){setHiddenVers(h=>h.includes(vid)?h.filter(x=>x!==vid):[...h,vid]);}
  function doExport(){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`scriptorium-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);}

  async function doReset(){
    if(!user||!projectId)return;
    setModal(null);setReady(false);setLoadMsg('Resetting — deleting entries…');
    const token=getToken();
    try{
      // Delete all entries and sections for this project
      const eT=await sbFrom('entries',token);await eT.delete({project_id:projectId});
      const sT=await sbFrom('sections',token);await sT.delete({project_id:projectId});
      // Delete all project_versions so defaults are re-applied
      const pvT=await sbFrom('project_versions',token);await pvT.delete({project_id:projectId});
      // Delete bookmarks and recents for this user
      const bmT=await sbFrom('bookmarks',token);await bmT.delete({user_id:user.id});
      const rpT=await sbFrom('recent_passages',token);await rpT.delete({user_id:user.id});
      setBookmarks([]);setRecents([]);
      // Reset UI prefs
      setHiddenVers([]);setQ('');setFilters({issueTypes:[],statuses:[],vA:'',vB:''});setDark(true);setTab('read');
      localStorage.setItem('scrip:dark','true');localStorage.setItem('scrip:hidden','[]');
      // Re-seed with defaults (same logic as fresh user)
      setLoadMsg('Restoring defaults…');
      await dbSaveVersions(projectId,PUBLIC_VERSIONS);
      const s1id=await dbSaveSection({title:'§ I — Default Section',description:'Starting point for your study. Edit or delete freely.',_isNew:true},projectId);
      const s2id=await dbSaveSection({title:'§ II — Default Section',description:'',_isNew:true},projectId);
      const refVid='kjv';
      const g11texts=await dbAutoFill(1,1,1,PUBLIC_VERSIONS.map(v=>v.id));
      const j316texts=await dbAutoFill(43,3,16,PUBLIC_VERSIONS.map(v=>v.id));
      const G11_FALLBACK={kjv:'In the beginning God created the heaven and the earth.',rvg:'En el principio creó Dios los cielos y la tierra.'};
      const J316_FALLBACK={kjv:'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',rvg:'Porque de tal manera amó Dios al mundo, que ha dado a su Hijo unigénito, para que todo aquel que en él cree, no se pierda, mas tenga vida eterna.'};
      const vdata1={};for(const v of PUBLIC_VERSIONS){const txt=g11texts[v.id]||G11_FALLBACK[v.id]||'';if(txt)vdata1[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
      const vdata2={};for(const v of PUBLIC_VERSIONS){const txt=j316texts[v.id]||J316_FALLBACK[v.id]||'';if(txt)vdata2[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
      const e1={id:genId(),sectionId:s1id,reference:'Genesis 1:1',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:vdata1,_isNew:true};
      const e2={id:genId(),sectionId:s2id,reference:'John 3:16',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:vdata2,_isNew:true};
      await dbSaveEntry(e1,projectId);
      await dbSaveEntry(e2,projectId);
      const pd2=await dbLoadProject(projectId);
      setData(pd2);
      setReadVid('kjv');setReadBook(1);setReadCh(1);
    }catch(err){console.error('reset error:',err);setLoadMsg('Reset failed: '+String(err.message||err));}
    setLoadMsg('');setReady(true);
  }

  // ── Auth gate ──
  if(!authChecked)return(<div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg}}><Spinner/></div>);
  if(!user)return <AuthPanel onAuth={u=>setUser(u)}/>;
  if(recoveryMode)return <RecoveryPanel T={D} onDone={()=>setRecoveryMode(false)}/>;

  // ── Loading ──
  if(!ready||!data)return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg}}>
      
      <div className="fade-up" style={{textAlign:'center'}}>
        <div style={{fontFamily:FS,fontSize:28,fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
        <div style={{fontFamily:FB,fontStyle:'italic',fontSize:14,color:D.gM,marginBottom:24,lineHeight:1.7}}>"The words of the LORD are pure words: as silver tried<br/>in a furnace of earth, purified seven times." — Psalm 12:6</div>
      </div>
      <div className="fade-up stagger-2" style={{display:'flex',flexDirection:'column',alignItems:'center',gap:14,marginTop:12}}>
        <div style={{width:160,height:2,overflow:'hidden',background:D.bd,borderRadius:1}}><div style={{width:'100%',height:'100%',background:'linear-gradient(90deg,transparent,#c8a84e,transparent)',backgroundSize:'200% 100%',animation:'goldLine 1.5s ease-in-out infinite'}}/></div>
        <div className="breathe" style={{fontFamily:FB,fontStyle:'italic',fontSize:15,color:D.gM}}>{loadMsg||'Loading…'}</div>
      </div>
    </div>
  );

  const filtered=getFiltered();
  const visibleVersions=data.versions.filter(v=>!hiddenVers.includes(v.id));

  return(
    <div style={{fontFamily:FB,background:T.bg,position:'fixed',inset:0,color:T.body,fontSize:16,display:'flex',flexDirection:'column',overflow:'hidden'}}>
      

      {/* ═══ EMAIL VERIFIED WELCOME OVERLAY ═══ */}
      {authWelcome&&(
        <div className="modal-in" style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:16,width:'min(92vw,420px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.7)',textAlign:'center'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'40px 36px 36px'}}>
              <div style={{fontSize:36,marginBottom:16}}>✓</div>
              <div style={{fontFamily:FS,fontSize:17,fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:12}}>Email Verified</div>
              <div style={{fontFamily:FB,fontSize:15,color:D.mut,lineHeight:1.8,marginBottom:28}}>
                Your account is confirmed. Welcome to Scriptorium — your Bible study workspace is ready.
              </div>
              <button type="button" onClick={()=>setAuthWelcome(false)}
                style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:8,color:D.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.14em',textTransform:'uppercase',padding:'12px 0',fontWeight:600,cursor:'pointer'}}>
                Enter Scriptorium
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ HEADER ═══ */}
      <div ref={navRef} className="no-print app-header" style={{background:T.bgCard,borderBottom:`1px solid ${T.bdA}`,padding:'calc(12px + env(safe-area-inset-top, 0px)) 6px 6px',position:'fixed',top:0,left:0,right:0,zIndex:200,touchAction:'none',userSelect:'none',WebkitUserSelect:'none',willChange:'transform'}}>
        <div style={{height:3,background:T.accentLine,position:'absolute',top:'env(safe-area-inset-top, 0px)',left:0,right:0}}/>
        <div className="app-header-row" style={{display:'flex',alignItems:'center',gap:4,minHeight:0,overflow:'hidden',flexWrap:'nowrap'}}>
          {/* Logo */}
          <div className="hide-mobile" style={{flexShrink:0}}>
            <h1 style={{fontFamily:FS,fontSize:17,fontWeight:700,color:T.gT,letterSpacing:'0.07em',margin:0,lineHeight:1}}>Scriptorium</h1>
            <div className="hide-mobile" style={{fontFamily:FS,fontSize:8,color:T.gD,letterSpacing:'0.18em',textTransform:'uppercase',fontWeight:500,marginTop:2}}>{data.versions.map(v=>v.label).join(' - ')}</div>
          </div>
          {/* ── 6-button nav bar ── */}
          {(()=>{
            const studyActive=['parallel','compare','strongs','dictionary','maps','charts','other'].includes(tab);
            const nb=(active)=>({display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',transition:'all .15s',borderRadius:6,fontFamily:FS,letterSpacing:'0.07em',background:active?T.gF:'transparent',border:`1px solid ${active?T.gD:'transparent'}`,color:active?T.gT:T.dim});
            const pill={display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3,gap:2,height:44,boxSizing:'border-box',alignItems:'stretch',flexShrink:0};
            return(
            <div style={{display:'flex',flex:1,gap:4,alignItems:'stretch',minWidth:0,boxSizing:'border-box'}}>
              {/* Settings pill */}
              <div style={pill}>
                <button type="button" title="Settings" onClick={()=>readMobileSheet==='settings'?closeReadSheet():setReadMobileSheet('settings')} style={{...nb(readMobileSheet==='settings'),width:44,fontSize:17,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
              </div>
              {/* Tab pill: Read | Study */}
              <div style={{...pill,flex:1}}>
                <button type="button" onClick={()=>{if(readFullScreen.current)exitFullScreen();if(readMobileSheet)closeReadSheet();if(tab==='parallel'){const same=parallelBk===readBook&&parallelCh===readCh;setReadBook(parallelBk);setReadCh(parallelCh);readScrollToVerse.current=parallelVs;if(same){setTimeout(()=>{const el=document.getElementById(`rv-${parallelVs}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(parallelVs);return ns;});readScrollToVerse.current=null;},80);}}setTab('read');}} style={{...nb(tab==='read'),flex:1,fontSize:10.5,fontWeight:tab==='read'?600:400,whiteSpace:'nowrap',padding:'0 12px'}}>&#10022; Read</button>
                <button type="button" onClick={()=>{if(readFullScreen.current)exitFullScreen();readMobileSheet==='studyTools'?closeReadSheet():setReadMobileSheet('studyTools');}} style={{...nb(studyActive),flex:1,fontSize:10.5,fontWeight:studyActive?600:400,whiteSpace:'nowrap',padding:'0 12px'}}>&#9998; Study</button>
              </div>
              {/* Tools pill: Search, Version, Navigate */}
              <div style={pill}>
                <button type="button" title="Search" onClick={tab==='compare'?()=>setMobileSheet('compareSearch'):!studyActive?()=>(readMobileSheet==='search'?closeReadSheet():setReadMobileSheet('search')):undefined} style={{...nb(tab==='compare'?!!q:!studyActive&&!!readSearchRes),width:44,fontSize:21,paddingLeft:2,visibility:tab==='compare'||!studyActive?'visible':'hidden'}}>
                  {readSearching&&!studyActive?<Spinner/>:'⌕'}
                </button>
                <button type="button" title="Navigate" onClick={tab==='parallel'||!studyActive?()=>{if(readMobileSheet==='nav'){closeReadSheet();}else{setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);setReadMobileSheet('nav');}}:undefined} style={{...nb(false),width:44,background:studyActive?'transparent':T.gF,border:`1px solid ${studyActive?'transparent':T.gD}`,color:studyActive?T.dim:T.gT,visibility:tab==='parallel'||!studyActive?'visible':'hidden'}}>
                  <svg width="22" height="18" viewBox="0 0 22 18" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                    {/* left page */}
                    <path d="M10.5 4.5 Q7 2.5 3 2.5 Q2 2.5 2 3.5 L2 13.5 Q2 14.5 3 14.5 Q7 14.5 10.5 15 Z" strokeWidth="1.2" fill="none"/>
                    {/* right page */}
                    <path d="M11.5 4.5 Q15 2.5 19 2.5 Q20 2.5 20 3.5 L20 13.5 Q20 14.5 19 14.5 Q15 14.5 11.5 15 Z" strokeWidth="1.2" fill="none"/>
                    {/* spine arch */}
                    <path d="M10.5 4.5 Q11 3 11.5 4.5" strokeWidth="1.2" fill="none"/>
                    {/* text lines left */}
                    <line x1="3.8" y1="6.2" x2="9.5" y2="6.2" strokeWidth="1.1"/>
                    <line x1="3.8" y1="7.9" x2="9.5" y2="7.9" strokeWidth="1.1"/>
                    <line x1="3.8" y1="9.6" x2="9.5" y2="9.6" strokeWidth="1.1"/>
                    <line x1="3.8" y1="11.3" x2="9.5" y2="11.3" strokeWidth="1.1"/>
                    <line x1="3.8" y1="13" x2="9.5" y2="13" strokeWidth="1.1"/>
                    {/* text lines right */}
                    <line x1="12.5" y1="6.2" x2="18.2" y2="6.2" strokeWidth="1.1"/>
                    <line x1="12.5" y1="7.9" x2="18.2" y2="7.9" strokeWidth="1.1"/>
                    <line x1="12.5" y1="9.6" x2="18.2" y2="9.6" strokeWidth="1.1"/>
                    <line x1="12.5" y1="11.3" x2="18.2" y2="11.3" strokeWidth="1.1"/>
                    <line x1="12.5" y1="13" x2="18.2" y2="13" strokeWidth="1.1"/>
                    {/* bookmark */}
                    <path d="M10.3 15 L10.3 17.5 L11 16.6 L11.7 17.5 L11.7 15" strokeWidth="1.2" fill="none"/>
                  </svg>
                </button>
                <button type="button" title="Select Version" onClick={!studyActive?()=>(readMobileSheet==='version'?closeReadSheet():setReadMobileSheet('version')):undefined} style={{...nb(false),color:studyActive?'transparent':T.gM,fontSize:10,fontWeight:600,width:44,padding:0,whiteSpace:'nowrap',visibility:studyActive?'hidden':'visible'}}>
                  {readVerLabel||'—'}
                </button>
              </div>
            </div>);
          })()}
          {/* Read controls (desktop only) - removed; now in 6-button nav */}
          {false&&<div className="hide-mobile" style={{display:'none'}}>
            <select className="s-btn" value={readVid||''} onChange={e=>setReadVid(e.target.value)}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.04em',padding:'0 6px',outline:'none',fontWeight:600,flexShrink:0}}>
              {(data?.versions||[]).map(v=><option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {/* Book */}
            <select className="s-btn" value={readBook} onChange={e=>{setReadBook(parseInt(e.target.value));setReadCh(1);}}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:11,padding:'0 4px',outline:'none',maxWidth:110}}>
              {BIBLE.map(b=><option key={b.n} value={b.n}>{b.name}</option>)}
            </select>
            {/* Chapter */}
            <select className="s-btn" value={readCh} onChange={e=>setReadCh(parseInt(e.target.value))}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:11,padding:'0 4px',outline:'none',width:48}}>
              {Array.from({length:readTotalCh},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
            {/* Verse */}
            <select className="s-btn" value="" onChange={e=>{const v=parseInt(e.target.value);if(v){const el=document.getElementById(`rv-${v}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});}}}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FB,fontSize:11,padding:'0 4px',outline:'none',width:48}}>
              <option value="">Vs</option>
              {Array.from({length:readBk?.v?.[readCh-1]||0},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
            {/* Search */}
            <button type="button" className="s-btn s-ghost" title="Search" onClick={()=>doReadSearch()} disabled={readSearching}
              style={{height:33.33,boxSizing:'border-box',background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,padding:'0 8px',flexShrink:0,fontSize:17,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>{readSearching?<Spinner/>:'⌕'}</button>
            <input value={readSearchQ} onChange={e=>{setReadSearchQ(e.target.value);if(e.target.value)setReadSearchPopover(true);}} onKeyDown={e=>e.key==='Enter'&&doReadSearch()}
              placeholder="Search…"
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:11,padding:'0 8px',outline:'none',width:150}}/>
            {/* Options toggle */}
            {(()=>{const act=searchOpts.scope!=='all'||searchOpts.mode!=='any'||searchOpts.caseSensitive||searchOpts.partial;return(
              <button type="button" title="Search options" onClick={()=>setReadSearchPopover(v=>!v)}
                style={{height:33.33,boxSizing:'border-box',background:readSearchPopover||act?T.gF:'none',border:`1px solid ${readSearchPopover||act?T.gD:T.bd}`,borderRadius:6,color:readSearchPopover||act?T.gT:T.dim,padding:'0 9px',flexShrink:0,fontSize:11,fontFamily:FS,letterSpacing:'0.05em',display:'flex',alignItems:'center',gap:3,cursor:'pointer',whiteSpace:'nowrap',transition:'all .15s'}}>
                ⊟{act&&<span style={{fontSize:7,background:T.gM,color:'#fff',borderRadius:3,padding:'1px 3px',lineHeight:1}}>●</span>}
              </button>
            );})()}
            {readSearchRes&&<button type="button" title="Clear search" onClick={()=>{setReadSearchRes(null);setReadSearchQ('');}} style={{background:'none',border:'none',color:T.dim,fontSize:14,cursor:'pointer',flexShrink:0,lineHeight:1}}>✕</button>}
            {/* Settings button + popover */}
            <button type="button" title="Reading settings" onClick={()=>setReadSettingsOpen(v=>!v)}
              style={{height:33.33,boxSizing:'border-box',background:readSettingsOpen?T.gF:'none',border:`1px solid ${readSettingsOpen?T.gD:T.bd}`,borderRadius:6,color:readSettingsOpen?T.gT:T.dim,padding:'0 9px',flexShrink:0,fontSize:14,display:'flex',alignItems:'center',cursor:'pointer',transition:'all .15s'}}>⚙</button>
            {readSettingsOpen&&<>
              <div onClick={()=>setReadSettingsOpen(false)} style={{position:'fixed',inset:0,zIndex:499}}/>
              <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% + 8px)',right:0,zIndex:500,background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,padding:'16px 18px',width:260,boxShadow:'0 8px 32px rgba(0,0,0,0.28)',maxHeight:'calc(100dvh - 110px)',overflowY:'auto'}}>
                <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.16em',color:T.gM,marginBottom:12,textTransform:'uppercase',fontWeight:600}}>Reading Settings</div>
                {/* Dark/light */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                  <span style={{fontFamily:FB,fontSize:13,color:T.mut}}>{dark?'Dark Mode':'Light Mode'}</span>
                  <button type="button" onClick={()=>setDark(d=>!d)}
                    style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:20,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 12px',cursor:'pointer',fontWeight:600}}>
                    {dark?'☀ Light':'☾ Dark'}
                  </button>
                </div>
                {/* Strong's */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                  <span style={{fontFamily:FB,fontSize:13,color:T.mut}}>Strong's Concordance</span>
                  <button type="button" onClick={()=>setStrongsMode(v=>!v)}
                    style={{background:strongsMode?T.gF:'transparent',border:`1px solid ${strongsMode?T.gD:T.bd}`,borderRadius:20,color:strongsMode?T.gT:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 12px',cursor:'pointer',fontWeight:strongsMode?600:400,transition:'all .15s'}}>
                    {strongsMode?'On':'Off'}
                  </button>
                </div>
                {/* Manage versions */}
                <button type="button" onClick={()=>{setReadSettingsOpen(false);setModal({type:'versions'});}}
                  style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:13,padding:'9px 12px',cursor:'pointer',marginBottom:14,boxSizing:'border-box'}}>
                  <span style={{color:T.gT}}>⚙</span> Manage Bible Versions
                </button>
                {/* Font size */}
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <span style={{fontFamily:FB,fontSize:13,color:T.mut}}>Text Size</span>
                    <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.1em'}}>{readFontSize}px</span>
                  </div>
                  <input type="range" min="13" max="42" value={readFontSize}
                    onChange={e=>{const v=Number(e.target.value);setReadFontSize(v);try{localStorage.setItem('scrip:fontSize',v);}catch{}}}
                    style={{width:'100%',accentColor:T.gM,cursor:'pointer'}}/>
                  <div style={{display:'flex',justifyContent:'space-between',marginTop:2,marginBottom:8}}>
                    <span style={{fontFamily:FS,fontSize:8,color:T.dim}}>A</span>
                    <span style={{fontFamily:FS,fontSize:12,color:T.dim}}>A</span>
                  </div>
                  <div style={{borderTop:`1px solid ${T.bd}`,paddingTop:8,color:T.body,fontFamily:FB,fontSize:readFontSize,lineHeight:1.75}}>
                    In the beginning God created the heaven and the earth.
                  </div>
                </div>
              </div>
            </>}
            {/* Search options popover */}
            {readSearchPopover&&<>
              <div onClick={()=>setReadSearchPopover(false)} style={{position:'fixed',inset:0,zIndex:499}}/>
              <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% + 8px)',right:0,zIndex:500,background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,padding:'14px 16px',width:310,boxShadow:'0 8px 32px rgba(0,0,0,0.28)'}}>
                {/* Scope */}
                <div style={{marginBottom:12}}>
                  <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.16em',color:T.gM,marginBottom:6,textTransform:'uppercase',fontWeight:600}}>Scope</div>
                  <div style={{display:'flex',gap:4}}>
                    {[['all','All Scripture'],['ot','OT Only'],['nt','NT Only']].map(([v,l])=>(
                      <button key={v} type="button" onClick={()=>setSearchOpts(o=>({...o,scope:v}))}
                        style={{flex:1,background:searchOpts.scope===v?T.gF:'transparent',border:`1px solid ${searchOpts.scope===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.scope===v?T.gT:T.dim,fontFamily:FS,fontSize:8.5,letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Match mode */}
                <div style={{marginBottom:12}}>
                  <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.16em',color:T.gM,marginBottom:6,textTransform:'uppercase',fontWeight:600}}>Match Mode</div>
                  <div style={{display:'flex',gap:4}}>
                    {[['all','All Words'],['phrase','Phrase'],['any','Any Word']].map(([v,l])=>(
                      <button key={v} type="button" onClick={()=>setSearchOpts(o=>({...o,mode:v}))}
                        style={{flex:1,background:searchOpts.mode===v?T.gF:'transparent',border:`1px solid ${searchOpts.mode===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.mode===v?T.gT:T.dim,fontFamily:FS,fontSize:8.5,letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s',whiteSpace:'nowrap'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Toggles */}
                <div style={{display:'flex',gap:6,marginBottom:recentSearches.length>0?14:0}}>
                  {[['caseSensitive','Case Sensitive'],['partial','Partial Match']].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>setSearchOpts(o=>({...o,[k]:!o[k]}))}
                      style={{flex:1,background:searchOpts[k]?'rgba(210,60,60,0.13)':'transparent',border:`1px solid ${searchOpts[k]?'rgba(210,60,60,0.4)':T.bd}`,borderRadius:6,color:searchOpts[k]?(dark?'#e08888':'#bf4040'):T.dim,fontFamily:FS,fontSize:8.5,letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s'}}>
                      {l}
                    </button>
                  ))}
                </div>
                {/* Recent searches */}
                {recentSearches.length>0&&(
                  <div>
                    <div style={{height:1,background:T.bd,marginBottom:10}}/>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:7}}>
                      <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.16em',color:T.gM,textTransform:'uppercase',fontWeight:600}}>Recent Searches</div>
                      <button type="button" onClick={()=>{setRecentSearches([]);try{localStorage.removeItem('scrip_recent_searches');}catch{}}} style={{background:'none',border:'none',color:T.dim,fontSize:9,cursor:'pointer',fontFamily:FS,letterSpacing:'0.06em'}}>clear all</button>
                    </div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
                      {recentSearches.map(r=>(
                        <button key={r} type="button" onClick={()=>doReadSearch(r)}
                          style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FB,fontSize:11,padding:'3px 9px',cursor:'pointer',transition:'background .1s'}}>
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>}
          </div>}
          <div className="hide-mobile" style={{flex:1}}/>
          {/* Desktop: full button row */}
          <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:6}}>
            {saveStatus==='saving'&&<span style={{fontFamily:FS,fontSize:9,letterSpacing:'0.1em',fontWeight:500,color:T.gM}}>● Saving…</span>}
            <div style={{display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3,gap:2}}>
              <GhostBtn T={T} ch="✦ Bookmarks" onClick={()=>setModal({type:'bookmarks'})}/>
              <GhostBtn T={T} ch="↺ Recents" onClick={()=>setModal({type:'recents'})}/>
              <GhostBtn T={T} ch={dark?'☀':'☾'} onClick={()=>setDark(!dark)} title={dark?'Light mode':'Dark mode'}/>
              <GhostBtn T={T} ch="⋯" onClick={()=>setModal({type:'help'})} title="Help & more"/>
            </div>
            <div style={{display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3}}>
              <button type="button" onClick={()=>Auth.signOut()} style={{background:'transparent',border:'1px solid transparent',borderRadius:6,color:T.body,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'5px 11px',whiteSpace:'nowrap',cursor:'pointer',fontWeight:400}}>→ Sign Out</button>
            </div>
          </div>
          {saveStatus==='saving'&&<span className="show-mobile" style={{fontFamily:FS,fontSize:9,color:T.gM,whiteSpace:'nowrap',flexShrink:0}}>● Saving…</span>}
        </div>
      </div>

      {/* Mobile menu sheet */}
      {mobileSheet==='menu'&&(
        <MobileSheet T={T} title={null} onClose={closeMobileSheet} isClosing={mobileSheetClosing} fromTop topOffset={navH}>
          <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
              <button type="button" onClick={closeMobileSheet}
                style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                ←
              </button>
            </div>
            <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Menu</div>
          </div>
          {[
            {icon:'✦',label:'Bookmarks',fn:()=>{closeMobileSheet();setModal({type:'bookmarks'});}},
            {icon:'↺',label:'Recent Passages',fn:()=>{closeMobileSheet();setModal({type:'recents'});}},
            {icon:dark?'☀':'☾',label:dark?'Light Mode':'Dark Mode',fn:()=>setDark(!dark)},
            {icon:'⋯',label:'Help & Reference',fn:()=>{closeMobileSheet();setModal({type:'help'});}},
          ].map(item=>(
            <button key={item.label} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginBottom:6}}>
              <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>{item.icon}</span>{item.label}
            </button>
          ))}
          <div style={{height:1,background:T.bd,margin:'8px 0 10px'}}/>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:9,color:T.redTxt,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%'}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>Sign Out
          </button>
        </MobileSheet>
      )}

      {/* ═══ STUDY TOOLS DROPDOWN SHEET ═══ */}
      {readMobileSheet==='studyTools'&&(
        <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH}>
          <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
              <button type="button" onClick={closeReadSheet}
                style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                ←
              </button>
            </div>
            <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Study Tools</div>
          </div>
          {[
            {icon:'☰',label:'Parallel',sub:'Compare the same verse across versions',key:'parallel',fn:()=>{setParallelVids(pv=>pv.length?pv:data.versions.map(v=>v.id));setParallelBk(readBook);setParallelCh(readCh);setParallelVs(readSelVerses.size>0?Math.min(...readSelVerses):1);setTab('parallel');closeReadSheet();}},
            {icon:'✎',label:'Compare',sub:'Study notes and verse analysis',key:'compare',fn:()=>{setTab('compare');closeReadSheet();}},
            {icon:'ℍ',label:"Strong's Concordance",sub:'Hebrew & Greek word study',key:'strongs',fn:()=>{setTab('strongs');closeReadSheet();}},
            {icon:'Δ',label:'Dictionary',sub:'Biblical definitions and references',key:'dictionary',fn:()=>{setTab('dictionary');closeReadSheet();}},
            {icon:null,iconSvg:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>,label:'Maps',sub:'Biblical maps and geography',key:'maps',fn:()=>{setTab('maps');closeReadSheet();}},
            {icon:'▦',label:'Charts',sub:'Timelines and visual references',key:'charts',fn:()=>{setTab('charts');closeReadSheet();}},
            {icon:'⋯',label:'Other Resources',sub:'Additional study materials',key:'other',fn:()=>{setTab('other');closeReadSheet();}},
          ].map(item=>(
            <button key={item.key} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:14,textAlign:'left',width:'100%',background:tab===item.key?T.gF:'transparent',border:`1px solid ${tab===item.key?T.gD:T.bd}`,borderRadius:9,color:tab===item.key?T.gT:T.mut,fontFamily:FB,fontSize:18,padding:'13px 16px',marginBottom:7}}>
              <span style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontSize:13,flexShrink:0,fontFamily:FS}}>{item.iconSvg||item.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FS,fontSize:16,fontWeight:600,letterSpacing:'0.05em',color:tab===item.key?T.gT:T.mut}}>{item.label}</div>
                <div style={{fontFamily:FB,fontSize:11,color:T.dim,marginTop:2}}>{item.sub}</div>
              </div>
              {tab===item.key&&<span style={{fontFamily:FS,fontSize:9,letterSpacing:'0.1em',color:T.gM}}>ACTIVE</span>}
            </button>
          ))}
        </MobileSheet>
      )}

      {/* ═══ SETTINGS SHEET (global, works from any tab) ═══ */}
      {readMobileSheet==='settings'&&(
        <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} maxSheetHeight={`calc(100vh - ${navH}px - 50px)`}>
          {/* Header row: back + absolutely centered title + dark mode pill */}
          <div style={{position:'relative',display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
            <button type="button" onClick={closeReadSheet}
              style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,zIndex:1}}>
              ←
            </button>
            <div style={{position:'absolute',left:0,right:0,textAlign:'center',fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',pointerEvents:'none'}}>Settings</div>
            {/* Dark mode pill — compact */}
            <div onClick={()=>setDark(d=>!d)} style={{position:'relative',width:72,height:32,borderRadius:16,background:dark?T.bgCard:'#e8e4d8',boxShadow:dark?`0 0 0 1.5px ${T.gD},0 3px 10px rgba(0,0,0,0.5)`:'0 0 0 1.5px #c8c0a0,0 3px 10px rgba(0,0,0,0.12)',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',flexShrink:0,transition:'background .3s,box-shadow .3s',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,bottom:0,left:dark?8:'auto',right:dark?'auto':8,display:'flex',alignItems:'center',justifyContent:'center',width:32,pointerEvents:'none'}}>
                <span style={{fontFamily:FS,fontSize:7,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',color:dark?T.gT:'#8a8070',lineHeight:1.2,textAlign:'center',transition:'color .3s'}}>{dark?'Dark':'Light'}</span>
              </div>
              <div style={{position:'absolute',top:3,left:dark?'calc(100% - 29px)':3,width:26,height:26,borderRadius:'50%',background:dark?T.bgSec:'#ffffff',boxShadow:dark?`0 2px 6px rgba(0,0,0,0.5),0 0 0 1px ${T.gD}`:'0 2px 6px rgba(0,0,0,0.18)',display:'flex',alignItems:'center',justifyContent:'center',transition:'left .25s cubic-bezier(.4,0,.2,1),background .3s',fontSize:13}}>
                {dark
                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:T.gT}}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:'#a09070'}}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                }
              </div>
            </div>
          </div>
          {/* Read-tab toggles: Strong's + Auto Fullscreen — compact row */}
          {tab==='read'&&<div style={{display:'flex',gap:8,marginBottom:14}}>
            {/* Strong's card */}
            <div onClick={()=>setStrongsMode(v=>!v)} style={{flex:1,padding:'9px 10px',background:strongsMode?T.gF:T.bgSec,border:`1.5px solid ${strongsMode?T.gD:T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',transition:'background .2s,border-color .2s',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:18,color:strongsMode?T.gT:T.dim,flexShrink:0,transition:'color .2s'}}>ℍ</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:12,fontWeight:600,color:strongsMode?T.mut:T.dim,transition:'color .2s'}}>Strong's</div>
                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>Hebrew & Greek</div>
              </div>
              <span onClick={e=>{e.stopPropagation();setStrongsInfoVisible(v=>!v);}} style={{fontSize:11,color:T.gM,cursor:'pointer',flexShrink:0}}>ⓘ</span>
            </div>
            {/* Auto Fullscreen card */}
            <div onClick={()=>{const v=!readAutoFullscreen;setReadAutoFullscreen(v);try{localStorage.setItem('scrip:autoFullscreen',JSON.stringify(v));}catch{};if(!v&&readFullScreen.current)exitFullScreen();}} style={{flex:1,padding:'9px 10px',background:readAutoFullscreen?T.gF:T.bgSec,border:`1.5px solid ${readAutoFullscreen?T.gD:T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',transition:'background .2s,border-color .2s',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:18,color:readAutoFullscreen?T.gT:T.dim,flexShrink:0,transition:'color .2s'}}>⛶</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:12,fontWeight:600,color:readAutoFullscreen?T.mut:T.dim,transition:'color .2s'}}>Fullscreen</div>
                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>Auto on scroll</div>
              </div>
            </div>
          </div>}
          {strongsInfoVisible&&tab==='read'&&<div style={{marginTop:-8,marginBottom:14,padding:'10px 14px',background:T.bgSec,border:`1px solid ${T.gD}`,borderRadius:9,display:'flex',gap:8,alignItems:'flex-start'}}>
            <span style={{color:T.gT,flexShrink:0}}>ⓘ</span>
            <span style={{fontFamily:FB,fontSize:13,color:T.mut,lineHeight:1.5}}>Underlines every word with its original Hebrew or Greek number. Tap any word to see its definition and every verse where it appears. KJV only.</span>
          </div>}
          {/* ── Appearance (universal accordion) ── */}
          <button type="button" onClick={()=>setSettingsAppOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:settingsAppOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s'}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>Aa</span>
            <span style={{flex:1,textAlign:'left'}}>Reading Appearance</span>
            <span style={{fontSize:12,color:T.gM,transition:'transform .2s',display:'inline-block',transform:settingsAppOpen?'rotate(180deg)':'rotate(0deg)'}}>▾</span>
          </button>
          {settingsAppOpen&&<div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'14px 14px 10px',marginBottom:14}}>

            {/* Accent Color */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:8}}>Accent Color</div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {Object.entries(ACCENTS).map(([key,pal])=>(
                  <button key={key} title={key[0].toUpperCase()+key.slice(1)} type="button" onClick={()=>setAccent(key)}
                    style={{width:28,height:28,borderRadius:'50%',background:pal.dark.g,border:`2px solid ${accent===key?T.gT:T.bd}`,cursor:'pointer',boxShadow:accent===key?`0 0 0 2px ${T.g}`:'none',transition:'box-shadow .15s,border-color .15s',flexShrink:0}}/>
                ))}
              </div>
            </div>

            {/* Text Size */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut}}>Text Size</span>
                <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.1em'}}>{readFontSize}px</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:FB,fontSize:11,color:T.dim}}>A</span>
                <input type="range" min="13" max="42" value={readFontSize}
                  onChange={e=>{const v=Number(e.target.value);setReadFontSize(v);try{localStorage.setItem('scrip:fontSize',v);}catch{}}}
                  style={{flex:1,accentColor:T.gM,cursor:'pointer'}}/>
                <span style={{fontFamily:FB,fontSize:20,color:T.dim}}>A</span>
              </div>
            </div>

            {/* Line Spacing */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut}}>Line Spacing</span>
                <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.1em'}}>{readLineHeight.toFixed(1)}</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:FS,fontSize:9,color:T.dim}}>Tight</span>
                <input type="range" min="1.1" max="2.8" step="0.1" value={readLineHeight}
                  onChange={e=>{const v=Number(e.target.value);setReadLineHeight(v);try{localStorage.setItem('scrip:lineHeight',v);}catch{}}}
                  style={{flex:1,accentColor:T.gM,cursor:'pointer'}}/>
                <span style={{fontFamily:FS,fontSize:9,color:T.dim}}>Wide</span>
              </div>
            </div>

            {/* Font Family */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:6}}>Font</div>
              <div style={{display:'flex',gap:4}}>
                {[['serif','Serif'],['sans','Sans-Serif'],['mono','Monospace']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadFontFamily(k);try{localStorage.setItem('scrip:fontFamily',k);}catch{}}}
                    style={{flex:1,background:readFontFamily===k?T.gF:'transparent',border:`1px solid ${readFontFamily===k?T.gD:T.bd}`,borderRadius:6,color:readFontFamily===k?T.gT:T.dim,fontFamily:k==='serif'?FB:k==='sans'?"'Inter','Segoe UI',system-ui,sans-serif":"'Courier New',monospace",fontSize:12,padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Text Alignment */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:6}}>Alignment</div>
              <div style={{display:'flex',gap:4}}>
                {[['left','Left'],['justify','Justified']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadTextAlign(k);try{localStorage.setItem('scrip:textAlign',k);}catch{}}}
                    style={{flex:1,background:readTextAlign===k?T.gF:'transparent',border:`1px solid ${readTextAlign===k?T.gD:T.bd}`,borderRadius:6,color:readTextAlign===k?T.gT:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Verse Numbers */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:6}}>Verse Numbers</div>
              <div style={{display:'flex',gap:4}}>
                {[['super','Superscript'],['inline','Inline'],['hidden','Hidden']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadVerseNums(k);try{localStorage.setItem('scrip:verseNums',k);}catch{}}}
                    style={{flex:1,background:readVerseNums===k?T.gF:'transparent',border:`1px solid ${readVerseNums===k?T.gD:T.bd}`,borderRadius:6,color:readVerseNums===k?T.gT:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles row */}
            <div style={{display:'flex',gap:6,marginBottom:14}}>
              <button type="button" onClick={()=>{const v=!readParaMode;setReadParaMode(v);try{localStorage.setItem('scrip:paraMode',JSON.stringify(v));}catch{}}}
                style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:readParaMode?T.gF:'transparent',border:`1px solid ${readParaMode?T.gD:T.bd}`,borderRadius:6,color:readParaMode?T.gT:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.05em',padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                <span>Paragraph Mode</span><span style={{fontSize:8,opacity:0.7}}>{readParaMode?'ON':'OFF'}</span>
              </button>
              <button type="button" onClick={()=>{const v=!readRedLetter;setReadRedLetter(v);try{localStorage.setItem('scrip:redLetter',JSON.stringify(v));}catch{}}}
                style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:readRedLetter?'rgba(198,40,40,0.15)':'transparent',border:`1px solid ${readRedLetter?'#c62828':T.bd}`,borderRadius:6,color:readRedLetter?'#ef5350':T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.05em',padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                <span>Red Letter</span><span style={{fontSize:8,opacity:0.7}}>{readRedLetter?'ON':'OFF'}</span>
              </button>
            </div>


            {/* Live preview */}
            {(()=>{
              const pvVerses=[
                {v:1,text:'The LORD <i>is</i> my shepherd; I shall not want.'},
                {v:2,text:'<red>I am the way, the truth, and the life.</red>'},
                {v:3,text:'God <i>is</i> love.'},
              ];
              const vnSup=(v)=>readVerseNums==='super'?<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:T.gM,marginRight:2,fontWeight:600}}>{v}</sup>:null;
              const vnInl=(v)=>readVerseNums==='inline'?<span style={{fontFamily:FS,fontSize:10,color:T.gM,marginRight:6,fontWeight:600}}>{v}</span>:null;
              return(
              <div style={{borderTop:`1px solid ${T.bd}`,paddingTop:12,marginTop:4}}>
                <div style={{fontFamily:FS,fontSize:7,letterSpacing:'0.14em',color:T.dim,textTransform:'uppercase',marginBottom:8}}>Preview</div>
                {readParaMode?(
                  <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,lineHeight:readLineHeight,textAlign:readTextAlign,color:T.body}}>
                    {pvVerses.map(({v,text})=>(
                      <span key={v}>{vnSup(v)}{vnInl(v)}<span dangerouslySetInnerHTML={{__html:processRedLetter(text,readRedLetter,dark)}}/>{' '}</span>
                    ))}
                  </div>
                ):(
                  <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,lineHeight:readLineHeight,textAlign:readTextAlign,color:T.body}}>
                    {pvVerses.map(({v,text})=>(
                      <div key={v} style={{marginBottom:1}}>{vnSup(v)}{vnInl(v)}<span dangerouslySetInnerHTML={{__html:processRedLetter(text,readRedLetter,dark)}}/></div>
                    ))}
                  </div>
                )}
              </div>);
            })()}

          </div>}
          {!settingsAppOpen&&<div style={{marginBottom:14}}/>}
          <button type="button" onClick={()=>{closeReadSheet();setModal({type:'versions'});}}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',cursor:'pointer',marginBottom:14,boxSizing:'border-box'}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></span>Manage Bible Versions
          </button>
          {/* ── Offline Data ── */}
          {(()=>{
            const offlineItems=[
              {id:'strongs',label:"Strong's Concordance",sub:'14,197 entries · Hebrew & Greek',icon:'ℍ'},
              {id:'webster',label:"Webster's 1828",sub:'107,793 entries · ~50 MB',icon:'W'},
            ];
            return(
              <div style={{marginBottom:14}}>
                <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>OFFLINE DATA</div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {offlineItems.map(item=>{
                    const dl=dlStates[item.id]||{};
                    const pct=dl.total>0?Math.round((dl.progress/dl.total)*100):0;
                    return(
                      <div key={item.id} style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:9,padding:'10px 12px'}}>
                        <div style={{display:'flex',alignItems:'center',gap:10}}>
                          <span style={{fontFamily:FS,fontSize:16,color:T.gT,width:22,textAlign:'center',flexShrink:0}}>{item.icon}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontFamily:FB,fontSize:13,fontWeight:600,color:T.mut}}>{item.label}</div>
                            <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>{item.sub}</div>
                          </div>
                          {dl.downloading?(
                            <span style={{fontFamily:FS,fontSize:10,color:T.gM,letterSpacing:'0.06em',flexShrink:0}}>{pct}%</span>
                          ):dl.downloaded?(
                            <button onClick={()=>deleteDownload(item.id)} style={{background:'none',border:`1px solid ${T.gD}`,borderRadius:6,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:9,letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>✓ Offline</button>
                          ):(
                            <button onClick={()=>startDownload(item.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>↓ Download</button>
                          )}
                          {dl.err&&<span style={{fontFamily:FB,fontSize:10,color:T.redTxt}}>Error</span>}
                        </div>
                        {dl.downloading&&dl.total>0&&(
                          <div style={{marginTop:7,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${pct}%`,background:T.gT,borderRadius:1,transition:'width .3s'}}/>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          <div style={{height:1,background:T.bd,margin:'4px 0 12px'}}/>
          {[
            {icon:'✦',label:'Bookmarks',fn:()=>{closeReadSheet();setModal({type:'bookmarks'});}},
            {icon:'↺',label:'Recent Passages',fn:()=>{closeReadSheet();setModal({type:'recents'});}},
            {icon:'⋯',label:'Help & Reference',fn:()=>{closeReadSheet();setModal({type:'help'});}},
          ].map(item=>(
            <button key={item.label} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginBottom:6}}>
              <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>{item.icon}</span>{item.label}
            </button>
          ))}
          <div style={{height:1,background:T.bd,margin:'4px 0 12px'}}/>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:9,color:T.redTxt,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%'}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>Sign Out
          </button>
        </MobileSheet>
      )}

      {/* ── Global popup sheets (nav / version / search) ── */}
          {readMobileSheet==='nav'&&(()=>{
            const isP=tab==='parallel';
            const setNavBk=isP?setParallelBk:setReadBook;
            const setNavCh=isP?setParallelCh:setReadCh;
            const pickedBkData=navPickedBk?BIBLE.find(b=>b.n===navPickedBk):null;
            const gridBtn={border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FS,fontSize:17,letterSpacing:'0.04em',padding:'12px 4px',cursor:'pointer',textAlign:'center',background:T.bgIn,minWidth:0};
            /* Dynamic book button height: fit all 22 rows (13 OT + 9 NT) without scrolling.
               Overhead: sheet padding 52+32, marginTop -44, header 28, line 11, OT label 30, NT label 25,
               grid gaps 12*2+8*2=40, paddingBottom 12, sheet border 2 ≈ 188px */
            /* 5 columns: OT=8 rows, NT=6 rows, total 14 rows */
            const bookBtnH=38;
            const bookBtn={border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FS,fontSize:12,letterSpacing:'0.01em',cursor:'pointer',textAlign:'center',background:T.bgIn,whiteSpace:'nowrap',overflow:'hidden',padding:'0 2px',height:bookBtnH,display:'flex',alignItems:'center',justifyContent:'center'};
            const gridBtnActive={...gridBtn,background:T.gF,border:`1px solid ${T.gD}`,color:T.gT};
            const ABBR={'Genesis':'Gen.','Exodus':'Exod.','Leviticus':'Lev.','Numbers':'Num.','Deuteronomy':'Deut.','Joshua':'Josh.','Judges':'Judg.','Ruth':'Ruth','1 Samuel':'1 Sam.','2 Samuel':'2 Sam.','1 Kings':'1 Kgs.','2 Kings':'2 Kgs.','1 Chronicles':'1 Chr.','2 Chronicles':'2 Chr.','Ezra':'Ezra','Nehemiah':'Neh.','Esther':'Esth.','Job':'Job','Psalms':'Ps.','Proverbs':'Prov.','Ecclesiastes':'Eccl.','Song of Solomon':'Song','Isaiah':'Isa.','Jeremiah':'Jer.','Lamentations':'Lam.','Ezekiel':'Ezek.','Daniel':'Dan.','Hosea':'Hos.','Joel':'Joel','Amos':'Amos','Obadiah':'Obad.','Jonah':'Jon.','Micah':'Mic.','Nahum':'Nah.','Habakkuk':'Hab.','Zephaniah':'Zeph.','Haggai':'Hag.','Zechariah':'Zech.','Malachi':'Mal.','Matthew':'Matt.','Mark':'Mark','Luke':'Luke','John':'John','Acts':'Acts','Romans':'Rom.','1 Corinthians':'1 Cor.','2 Corinthians':'2 Cor.','Galatians':'Gal.','Ephesians':'Eph.','Philippians':'Phil.','Colossians':'Col.','1 Thessalonians':'1 Thes.','2 Thessalonians':'2 Thes.','1 Timothy':'1 Tim.','2 Timothy':'2 Tim.','Titus':'Tit.','Philemon':'Phlm.','Hebrews':'Heb.','James':'Jas.','1 Peter':'1 Pet.','2 Peter':'2 Pet.','1 John':'1 Jn.','2 John':'2 Jn.','3 John':'3 Jn.','Jude':'Jude','Revelation':'Rev.'};
            function romanName(name){return ABBR[name]||name;}
            return(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} sheetHeight={navSheetH?navSheetH+'px':undefined}>
              <div ref={navContentRef} style={{overflowX:'hidden',maxWidth:'100%',paddingBottom:12}}>
                {/* Header row — back button + title — consistent across all steps */}
                <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  {navStep==='book'?(
                    <button type="button" onClick={closeReadSheet}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  ):navStep==='chapter'?(
                    <button type="button" onClick={()=>{setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);}}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  ):(
                    <button type="button" onClick={()=>{setNavStep('chapter');setNavPickedCh(null);}}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  )}
                  </div>
                  <div style={{textAlign:'center',fontFamily:FS,fontSize:20,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>
                    {navStep==='book'?'Select Book':navStep==='chapter'?pickedBkData?.name||'':`${pickedBkData?.name||''} ${navPickedCh}`}
                  </div>
                </div>
                <div style={{height:1,background:T.accentLine,marginBottom:10}}/>

                {/* Book grid — two independent scrollable columns */}
                {navStep==='book'&&(
                  <div style={{display:'flex',gap:8,height:`calc(100dvh - ${navH}px - 178px)`,overflow:'hidden'}}>
                    {[{label:'Old Testament',filter:b=>b.n<=39},{label:'New Testament',filter:b=>b.n>=40}].map(({label,filter})=>(
                      <div key={label} style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
                        <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.28em',color:T.gM,textTransform:'uppercase',fontWeight:600,textAlign:'center',marginBottom:6,flexShrink:0,width:'100%',wordSpacing:'0.4em'}}>{label}</div>
                        <div style={{overflowY:'auto',flex:1,display:'flex',flexDirection:'column',gap:4}}>
                          {BIBLE.filter(filter).map(b=>(
                            <button key={b.n} type="button" onClick={()=>{setNavPickedBk(b.n);setNavPickedCh(null);setNavStep('chapter');}}
                              style={{width:'100%',border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FS,fontSize:13,letterSpacing:'0.03em',cursor:'pointer',textAlign:'center',background:T.bgIn,padding:'9px 4px',boxSizing:'border-box',flexShrink:0}}>
                              {b.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Chapter grid */}
                {navStep==='chapter'&&pickedBkData&&<div>
                  <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.18em',color:T.gM,textTransform:'uppercase',fontWeight:600,marginBottom:5,marginTop:15,textAlign:'center'}}>
                    Select Chapter
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:5}}>
                    {Array.from({length:pickedBkData.v.length},(_,i)=>(
                      <button key={i+1} type="button" onClick={()=>{
                        setNavPickedCh(i+1);
                        setNavBk(navPickedBk);setNavCh(i+1);
                        if(isP){setParallelVs(1);}
                        setNavStep('verse');
                        setTimeout(()=>{const el=document.querySelector('.slide-down-sheet>div');if(el)el.scrollTop=0;},0);
                      }} style={gridBtn}>{i+1}</button>
                    ))}
                  </div>
                </div>}

                {/* Verse grid */}
                {navStep==='verse'&&pickedBkData&&navPickedCh&&<div>
                  <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.18em',color:T.gM,textTransform:'uppercase',fontWeight:600,marginBottom:5,marginTop:15,textAlign:'center'}}>
                    Select Verse
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:5}}>
                    {Array.from({length:pickedBkData.v[navPickedCh-1]||0},(_,i)=>(
                      <button key={i+1} type="button" onClick={()=>{
                        if(isP){setParallelVs(i+1);}
                        else{setTimeout(()=>{const el=document.getElementById(`rv-${i+1}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(i+1);return ns;});}},120);}
                        closeReadSheet();
                      }} style={gridBtn}>{i+1}</button>
                    ))}
                  </div>
                  <div style={{marginTop:16,textAlign:'center'}}>
                    <button type="button" onClick={()=>{
                      if(isP){setParallelVs(1);}
                      closeReadSheet();
                    }}
                      style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:10,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.1em',padding:'10px 28px',cursor:'pointer',fontWeight:600}}>
                      Go to Chapter {navPickedCh} →
                    </button>
                  </div>
                </div>}
              </div>
            </MobileSheet>);
          })()}
          {readMobileSheet==='version'&&(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH}>
              <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  <button type="button" onClick={closeReadSheet}
                    style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    ←
                  </button>
                </div>
                <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Select Version</div>
              </div>
              {(data?.versions||[]).map(v=>(
                <button key={v.id} type="button" className="s-btn s-ghost" onClick={()=>{setReadVid(v.id);closeReadSheet();}}
                  style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',background:readVid===v.id?T.gF:'transparent',border:`1px solid ${readVid===v.id?T.gD:T.bd}`,borderRadius:9,color:readVid===v.id?T.gT:T.mut,fontFamily:FB,fontSize:18,padding:'13px 16px',marginBottom:7}}>
                  <span>{v.label}</span>
                  <span style={{fontFamily:FS,fontSize:9,letterSpacing:'0.1em',color:readVid===v.id?T.gM:T.dim}}>{v.lang}</span>
                </button>
              ))}
            </MobileSheet>
          )}
          {readMobileSheet==='search'&&(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH}>
              <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  <button type="button" onClick={()=>{setReadSearchRes(null);setReadSearchQ('');closeReadSheet();}}
                    style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    ←
                  </button>
                </div>
                <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Search Verses</div>
              </div>
              <div style={{display:'flex',gap:8,marginBottom:12,alignItems:'center'}}>
                <input value={readSearchQ} onChange={e=>setReadSearchQ(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&doReadSearch()}
                  autoFocus
                  placeholder="Search all verses in this version…"
                  style={{flex:1,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 12px',outline:'none',minWidth:0}}/>
                <button type="button" className="s-btn s-ghost" onClick={()=>doReadSearch()} disabled={readSearching}
                  style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,padding:'9px 14px',fontWeight:600,flexShrink:0,fontSize:16}}>
                  {readSearching?<Spinner/>:'⌕'}
                </button>
              </div>
              {/* Search options */}
              <div style={{marginBottom:14,padding:'10px 12px',background:T.bgSec,borderRadius:8,border:`1px solid ${T.bd}`}}>
                <div style={{display:'flex',gap:4,marginBottom:7,alignItems:'center'}}>
                  <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',fontWeight:600,width:38,flexShrink:0}}>Scope</div>
                  {[['all','All'],['ot','OT'],['nt','NT']].map(([v,l])=>(
                    <button key={v} type="button" onClick={()=>{const o={...searchOpts,scope:v};setSearchOpts(o);}}
                      style={{flex:1,background:searchOpts.scope===v?T.gF:'transparent',border:`1px solid ${searchOpts.scope===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.scope===v?T.gT:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{display:'flex',gap:4,marginBottom:7,alignItems:'center'}}>
                  <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',fontWeight:600,width:38,flexShrink:0}}>Mode</div>
                  {[['all','All Words'],['phrase','Phrase'],['any','Any Word']].map(([v,l])=>(
                    <button key={v} type="button" onClick={()=>{const o={...searchOpts,mode:v};setSearchOpts(o);}}
                      style={{flex:1,background:searchOpts.mode===v?T.gF:'transparent',border:`1px solid ${searchOpts.mode===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.mode===v?T.gT:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s',whiteSpace:'nowrap'}}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{display:'flex',gap:4,alignItems:'center'}}>
                  <div style={{width:38,flexShrink:0}}/>
                  {[['caseSensitive','Case Sensitive'],['partial','Partial Match']].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>{const o={...searchOpts,[k]:!searchOpts[k]};setSearchOpts(o);}}
                      style={{flex:1,background:searchOpts[k]?'rgba(210,60,60,0.13)':'transparent',border:`1px solid ${searchOpts[k]?'rgba(210,60,60,0.4)':T.bd}`,borderRadius:6,color:searchOpts[k]?(dark?'#e08888':'#bf4040'):T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {/* Recent searches */}
              {recentSearches.length>0&&(
                <div style={{marginBottom:14}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                    <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',fontWeight:600}}>Recent Searches</div>
                    <button type="button" onClick={()=>{setRecentSearches([]);try{localStorage.removeItem('scrip_recent_searches');}catch{}}} style={{background:'none',border:'none',color:T.dim,fontSize:10,cursor:'pointer',fontFamily:FS,letterSpacing:'0.06em'}}>clear all</button>
                  </div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:7}}>
                    {recentSearches.map(r=>(
                      <button key={r} type="button" onClick={()=>doReadSearch(r)}
                        style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:13,padding:'5px 12px',cursor:'pointer'}}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </MobileSheet>
          )}

      {/* ═══ READ TAB ═══ */}
      {tab==='read'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0}}>

          {/* Search results header bar — fixed overlay below nav */}
          {readSearchRes&&tab==='read'&&!readMobileSheet&&(
            <div className="srch-bar-fixed" style={{position:'fixed',top:navH,left:0,right:0,zIndex:210,
              display:'flex',alignItems:'center',gap:10,padding:'14px 18px 14px',
              background:dark?'rgba(28,23,12,0.18)':'rgba(248,243,228,0.18)',
              backdropFilter:'blur(6px)',boxShadow:'0 2px 14px rgba(0,0,0,0.22)'}}>
              <div style={{height:1,background:'linear-gradient(90deg,transparent,rgb(74,62,34),rgb(200,168,78),rgb(74,62,34),transparent)',position:'absolute',bottom:0,left:0,right:0,transform:'translateY(100%)'}}/>
              <button type="button" onClick={()=>{setReadSearchRes(null);setReadSearchQ('');}}
                style={{display:'flex',alignItems:'center',gap:5,background:dark?'rgba(28,23,12,0.18)':'rgba(248,243,228,0.18)',border:`1px solid rgba(255,255,255,0.10)`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',fontWeight:600,padding:'6px 12px',cursor:'pointer',flexShrink:0,whiteSpace:'nowrap',transition:'all .15s'}}>
                ← Back to Reading
              </button>
              <div style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.08em',textTransform:'uppercase',fontWeight:500}}>
                <span>{readSearchRes.length} verse{readSearchRes.length!==1?'s':''}</span>
                <span style={{color:T.dim}}> · {readSearchOccurrences} occurrence{readSearchOccurrences!==1?'s':''}</span>
                <span style={{color:T.dim}}> for "{readSearchQ}"</span>
              </div>
            </div>
          )}


          {/* Custom overlay scrollbar thumb */}
          <div ref={scrollbarThumbRef} className="read-scrollbar"/>
          {/* Verse content */}
          <div ref={readRef} className="read-area" style={{flex:1,overflowY:'auto',padding:`${readSearchRes?navH+72:navH+8}px 5px 64px`,maxWidth:960,margin:'0 auto',width:'100%',boxSizing:'border-box'}}
            onTouchStart={e=>{
              swipeTouchX.current=e.touches[0].clientX;
              swipeTouchY.current=e.touches[0].clientY;
              swipeTouchT.current=Date.now();
              swipeDir.current=null;
            }}
            onTouchMove={e=>{
              if(swipeTouchX.current===null)return;
              const dx=e.touches[0].clientX-swipeTouchX.current;
              const dy=e.touches[0].clientY-swipeTouchY.current;
              if(!swipeDir.current&&(Math.abs(dx)>12||Math.abs(dy)>12)){
                swipeDir.current=Math.abs(dx)>Math.abs(dy)?'h':'v';
              }
            }}
            onTouchEnd={e=>{
              if(swipeTouchX.current===null)return;
              const wasH=swipeDir.current==='h';
              const dx=e.changedTouches[0].clientX-swipeTouchX.current;
              const dt=Math.max(1,Date.now()-swipeTouchT.current);
              const velocity=Math.abs(dx)/dt;
              swipeTouchX.current=null;
              swipeDir.current=null;
              if(!wasH)return;
              if(Math.abs(dx)<60&&velocity<0.35)return;
              if(dx<0)readNextCh();else readPrevCh();
            }}>
          {/* Chapter title */}
          {!readSearchRes&&(
            <div style={{textAlign:'center',padding:'10px 12px 2px'}}>
              <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.28em',textTransform:'uppercase',color:T.gM,marginBottom:2,fontWeight:500}}>{readVerLabel}</div>
              <div style={{fontFamily:FS,fontSize:19,fontWeight:600,color:T.gT,letterSpacing:'0.06em'}}>{readBk?.name} {readCh}</div>
              <div style={{height:1,background:T.accentLine,marginTop:8}}/>
            </div>
          )}
            {readSearchRes&&(
              <div>
                {readSearchRes.length===0&&(
                  <div>
                    <div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15,marginBottom:10}}>No verses found.</div>
                    {searchOpts.caseSensitive&&(
                      <div style={{fontSize:12,marginBottom:6,padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠ Case Sensitive is on — "{readSearchQ}" must match exact case.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,caseSensitive:false};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:12,padding:0,fontFamily:FB}}>Disable it →</button>
                      </div>
                    )}
                    {searchOpts.partial===false&&(
                      <div style={{fontSize:12,marginBottom:6,padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠ Whole Word mode — partial matches excluded.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,partial:true};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:12,padding:0,fontFamily:FB}}>Enable Partial Match →</button>
                      </div>
                    )}
                    {searchOpts.scope!=='all'&&(
                      <div style={{fontSize:12,padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠ Scope: {searchOpts.scope==='ot'?'OT Only':'NT Only'} — results limited.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,scope:'all'};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:12,padding:0,fontFamily:FB}}>Search All Scripture →</button>
                      </div>
                    )}
                  </div>
                )}
                {readSearchRes.length>1&&!readMobileSheet&&(()=>{
                  const booksInRes=[...new Map(readSearchRes.map(r=>[r.book_num,r])).keys()];
                  if(booksInRes.length<2)return null;
                  function srchAbbr(name){
                    if(name==='Philippians')return'Php';
                    if(name==='Philemon')return'Phm';
                    const m=name.match(/^(\d+)\s+(\w{2})/);
                    if(m)return m[1]+m[2];
                    return name.slice(0,3);
                  }
                  function jumpToBook(bn){
                    const idx=readSearchRes.findIndex(r=>r.book_num===parseInt(bn));
                    if(idx>=readSearchLimit){readSearchJumpTo.current=String(bn);setReadSearchLimit(idx+1);}
                    else{document.getElementById('srch-bk-'+bn)?.scrollIntoView({behavior:'smooth',block:'start'});}
                  }
                  return(
                    <div style={{position:'fixed',right:0,top:`calc(50% + ${Math.round(navH/2+28)}px)`,transform:'translateY(-50%)',zIndex:200,
                      display:'flex',flexDirection:'column',alignItems:'center',
                      background:dark?'rgba(28,23,12,0.18)':'rgba(248,243,228,0.18)',
                      borderRadius:'10px 0 0 10px',padding:'6px 2px',gap:0,
                      maxHeight:`calc(100vh - ${navH+80}px - env(safe-area-inset-bottom, 0px))`,overflowY:'auto',
                      boxShadow:'-2px 0 14px rgba(0,0,0,0.22)',backdropFilter:'blur(6px)'}}>
                      {booksInRes.map(bn=>{
                        const nm=BIBLE.find(x=>x.n===bn)?.name||'?';
                        return(
                          <button key={bn} type="button" onClick={()=>jumpToBook(bn)}
                            style={{background:'none',border:'none',color:T.gM,fontFamily:FS,fontSize:7.5,
                              letterSpacing:'0.03em',padding:'3px 6px',cursor:'pointer',lineHeight:1.1,
                              borderRadius:4,minWidth:28,textAlign:'center',fontWeight:600,whiteSpace:'nowrap'}}>
                            {srchAbbr(nm)}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                {(()=>{let lastBk=null;return readSearchRes.slice(0,readSearchLimit).map(r=>{const b=BIBLE.find(x=>x.n===r.book_num);const firstOfBook=r.book_num!==lastBk;if(firstOfBook)lastBk=r.book_num;return(
                  <div key={`${r.book_num}-${r.chapter}-${r.verse}`} id={firstOfBook?`srch-bk-${r.book_num}`:undefined} className="reading-verse s-btn" onClick={()=>{setReadBook(r.book_num);setReadCh(r.chapter);setReadSearchRes(null);setTimeout(()=>{const el=document.getElementById(`rv-${r.verse}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(new Set([r.verse]));}},200);}} style={{padding:'10px 12px',marginBottom:6,borderRadius:6,border:`1px solid ${T.bd}`,background:T.bgCard,cursor:'pointer'}}>
                    <div style={{fontFamily:FS,fontSize:10,color:T.gM,marginBottom:4,letterSpacing:'0.08em',fontWeight:500}}>{b?.name} {r.chapter}:{r.verse}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textAlign:readTextAlign}} dangerouslySetInnerHTML={{__html:hl(r.text,readSearchQ,searchOpts)}}/>
                  </div>
                );});})()}
                {readSearchLimit<readSearchRes.length&&(
                  <div style={{textAlign:'center',padding:'14px 0',color:T.dim,fontFamily:FS,fontSize:8,letterSpacing:'0.12em'}}>
                    ··· {readSearchRes.length-readSearchLimit} more ···
                  </div>
                )}
              </div>
            )}
            {!readSearchRes&&readVerses.length===0&&(
              <div style={{textAlign:'center',padding:'48px 0',color:T.dim,fontFamily:FB,fontStyle:'italic',fontSize:15}}>
                No verses found.<br/><span style={{fontSize:13,display:'block',marginTop:8}}>Select a version from the Compare tab &gt; Versions.</span>
              </div>
            )}
            {strongsMode&&readVid!=='kjv'&&!readSearchRes&&(
              <div style={{margin:'8px 8px 0',padding:'8px 14px',borderRadius:7,border:`1px solid ${T.gD}`,background:T.gF,display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:T.gT,fontSize:14,flexShrink:0}}>ℍ</span>
                <span style={{fontFamily:FB,fontSize:13,color:T.gM,lineHeight:1.4}}>Strong's mode is only available for KJV.</span>
              </div>
            )}
            {!readSearchRes&&readVerses.length>0&&(
              readParaMode?(
                <div style={{textAlign:readTextAlign,padding:'3px 4px'}}>
                  {readVerses.map(({verse:v,text})=>{
                    const sel=readSelVerses.has(v);
                    return(
                      <span key={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={()=>verseTouchEnd(v)}
                        onClick={()=>verseClick(v)} onDoubleClick={()=>verseClick(v,true)}
                        style={{cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',background:sel?T.gF:'transparent',borderRadius:sel?Math.round(readFontSize*0.15):0,padding:sel?`${Math.round(readFontSize*0.08)}px ${Math.round(readFontSize*0.1)}px`:0,boxShadow:sel?`0 0 0 ${Math.max(1,Math.round(readFontSize*0.04))}px ${T.gD}`:'none',transition:'all .12s'}}>
                        {readVerseNums==='super'&&<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:sel?T.gT:T.gM,marginRight:2,fontWeight:600}}>{v}</sup>}
                        {readVerseNums==='inline'&&<span style={{fontFamily:FS,fontSize:10,color:sel?T.gT:T.gM,marginRight:6,fontWeight:600}}>{v}</span>}
                        <span className="rv-text" style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight}}>
                          {strongsMode&&strongsData[v]?buildStrongsVerse(text,strongsData[v],handleStrongsWordTap,T,dark,readRedLetter):<span dangerouslySetInnerHTML={{__html:processRedLetter(readRedLetter&&text&&!text.includes('<red>')&&isWOJ(readBook,readCh,v)?`<red>${text}</red>`:text,readRedLetter,dark)}}/>}
                        </span>
                        {' '}
                      </span>
                    );
                  })}
                </div>
              ):(
                <div style={{textAlign:readTextAlign,padding:'3px 4px'}}>
                  {readVerses.map(({verse:v,text})=>{
                    const sel=readSelVerses.has(v);
                    return(
                      <div key={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={()=>verseTouchEnd(v)}
                        onClick={()=>verseClick(v)} onDoubleClick={()=>verseClick(v,true)}
                        style={{padding:'2px 4px',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',borderRadius:5,background:sel?T.gF:'transparent',boxShadow:sel?`0 0 0 1.5px ${T.gD}, 0 1px 6px rgba(200,168,78,0.18)`:'none',marginBottom:1,transition:'all .12s'}}>
                        {readVerseNums==='super'&&<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:sel?T.gT:T.gM,marginRight:2,userSelect:'none',fontWeight:600}}>{v}</sup>}
                        {readVerseNums==='inline'&&<span style={{fontFamily:FS,fontSize:10,color:sel?T.gT:T.gM,marginRight:6,userSelect:'none',fontWeight:600}}>{v}</span>}
                        <span className="rv-text" style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight}}>
                          {strongsMode&&strongsData[v]?buildStrongsVerse(text,strongsData[v],handleStrongsWordTap,T,dark,readRedLetter):<span dangerouslySetInnerHTML={{__html:processRedLetter(readRedLetter&&text&&!text.includes('<red>')&&isWOJ(readBook,readCh,v)?`<red>${text}</red>`:text,readRedLetter,dark)}}/>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>

          {/* Strong's popup */}
          {strongsPopup&&(()=>{
            function renderDerivation(text){
              if(!text)return null;
              const parts=[];let last=0;
              const re=/([HG]\d+)/g;let m;
              while((m=re.exec(text))!==null){
                if(m.index>last)parts.push(text.slice(last,m.index));
                const num=m[1];
                parts.push(<span key={m.index} onClick={e=>{e.stopPropagation();loadStrongsEntry(num);}} style={{color:T.gT,cursor:'pointer',fontWeight:600,textDecoration:'underline dotted'}}>{num}</span>);
                last=m.index+num.length;
              }
              if(last<text.length)parts.push(text.slice(last));
              return parts;
            }
            const verses=strongsPopup.verses||[];
            const totalCount=verses.length;
            const groups={};
            for(const r of verses){
              const key=(r.word_text||'').toLowerCase();
              if(!groups[key])groups[key]={word:r.word_text,refs:new Set()};
              groups[key].refs.add(`${r.book_num}|${r.chapter}|${r.verse}`);
            }
            const groupList=Object.entries(groups).sort((a,b)=>b[1].refs.size-a[1].refs.size);
            const bookName=bn=>BIBLE[bn-1]?.name||'';

            return(
              <MobileSheet T={T} onClose={closeStrongsPopup} isClosing={strongsClosing} title={null}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    {(strongsPopup.history||[]).length>0&&<button onClick={e=>{e.stopPropagation();goBackStrongs();}} style={{background:'none',border:'none',color:T.gT,cursor:'pointer',fontSize:16,padding:'0 4px 0 0',fontFamily:FB,fontWeight:600}}>&#8249; Back</button>}
                    <span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:T.gT,fontWeight:600}}>{strongsPopup.strongs_number}</span>
                    {totalCount>0&&<span style={{fontFamily:FB,fontSize:12,color:T.dim,background:T.bgCH,borderRadius:10,padding:'2px 7px'}}>&times;{totalCount}</span>}
                  </div>
                  <button onClick={closeStrongsPopup} style={{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:18}}>&#10005;</button>
                </div>
                {strongsPopup.entry?(
                  <div>
                    <div style={{fontSize:Math.max(24,Math.round(readFontSize*1.1)),color:T.body,marginBottom:4,fontFamily:fontFamilyMap[readFontFamily]}}>{strongsPopup.entry.original_word}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,marginBottom:2}}>{strongsPopup.entry.transliteration}{strongsPopup.entry.pronunciation?` (${strongsPopup.entry.pronunciation})`:''}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim,marginBottom:12,fontStyle:'italic'}}>{strongsPopup.entry.language==='hebrew'?'Hebrew':'Greek'}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,marginBottom:12}}>{strongsPopup.entry.short_def}</div>
                    {strongsPopup.entry.full_def&&<div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,lineHeight:readLineHeight,marginBottom:12}}>{renderDerivation(strongsPopup.entry.full_def)}</div>}
                    {groupList.length>0&&<div style={{borderTop:`1px solid ${T.bd}`,paddingTop:10,marginTop:4}}>
                      <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',color:T.gM,marginBottom:8}}>KJV USAGE</div>
                      {groupList.map(([key,{word,refs}])=>{
                        const isExpanded=strongsExpandedWords.has(key);
                        const refArr=[...refs].map(r=>{const[bn,ch,vs]=r.split('|').map(Number);return{bn,ch,vs};}).sort((a,b)=>a.bn-b.bn||a.ch-b.ch||a.vs-b.vs);
                        return(<div key={key} style={{marginBottom:8}}>
                          <div onClick={()=>setStrongsExpandedWords(s=>{const ns=new Set(s);ns.has(key)?ns.delete(key):ns.add(key);return ns;})}
                            style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',padding:'4px 0'}}>
                            <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,fontWeight:600}}>{word}</span>
                            <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim}}>(&times;{refs.size})</span>
                            <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.76),color:T.dim,marginLeft:'auto'}}>{isExpanded?'\u25b4':'\u25be'}</span>
                          </div>
                          {isExpanded&&<div style={{paddingLeft:8,paddingBottom:4}}>
                            {refArr.map(({bn,ch,vs})=>
                              <span key={`${bn}-${ch}-${vs}`} onClick={e=>{e.stopPropagation();openStrongsVersePreview(bn,ch,vs);}}
                                style={{display:'inline-block',fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.gT,cursor:'pointer',marginRight:10,marginBottom:4,textDecoration:'underline dotted'}}>
                                {`${bookName(bn)} ${ch}:${vs}`}</span>
                            )}
                          </div>}
                        </div>);
                      })}
                    </div>}
                    {groupList.length===0&&strongsPopup.versesLoading&&<div style={{fontFamily:FB,fontSize:13,color:T.dim,paddingTop:8}}>Loading verses&hellip;</div>}
                  </div>
                ):(
                  <div style={{textAlign:'center',padding:20,color:T.dim,fontFamily:FB}}>Loading...</div>
                )}
              </MobileSheet>
            );
          })()}

          {strongsVersePreview&&(
            <div onClick={()=>setStrongsVersePreview(null)} style={{position:'fixed',inset:0,zIndex:250,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px 20px',animation:'fadeIn .15s ease both'}}>
              <div onClick={e=>e.stopPropagation()} style={{background:T.bg,borderRadius:16,width:'100%',maxWidth:440,maxHeight:'60vh',overflow:'auto',padding:'20px 20px 28px',boxShadow:'0 8px 40px rgba(0,0,0,0.6)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                  <button onClick={()=>setStrongsVersePreview(null)} style={{background:'none',border:'none',color:T.gT,cursor:'pointer',fontFamily:FB,fontSize:22,fontWeight:600,padding:'0 8px 0 0',lineHeight:1}}>‹</button>
                  <span style={{fontFamily:FS,fontSize:12,letterSpacing:'0.12em',color:T.gT,fontWeight:600,flex:1,textAlign:'center'}}>{strongsVersePreview.label}</span>
                  <button onClick={()=>{setReadBook(strongsVersePreview.bn);setReadCh(strongsVersePreview.ch);closeStrongsPopup();setTab('read');}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,cursor:'pointer',fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'4px 10px',fontWeight:600}}>Go</button>
                </div>
                {strongsVersePreview.loading
                  ?<div style={{color:T.dim,fontFamily:FB,fontSize:13,textAlign:'center',padding:'12px 0'}}>Loading…</div>
                  :<div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight}}>
                    <sup style={{color:T.gM,fontWeight:600,marginRight:4,fontFamily:FS,fontSize:Math.round(readFontSize*0.68),verticalAlign:'super'}}>{strongsVersePreview.vs}</sup>
                    <span dangerouslySetInnerHTML={{__html:processRedLetter(strongsVersePreview.text,readRedLetter,dark)}}/>
                  </div>
                }
              </div>
            </div>
          )}

          {/* Selection action strip */}
          {stripOpen&&(
            <div className={stripClosing?'slide-down-strip':'slide-up-strip'} style={{position:'fixed',bottom:0,left:0,right:0,zIndex:160,background:T.bgCH,borderTop:`1px solid ${T.bdA}`,padding:readFullScreen.current?'10px 12px':'10px 12px 34px',display:'flex',flexDirection:'column',gap:8}}>
              {readBmOk
                ?<span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:'#62c484',fontWeight:600,textAlign:'center'}}>✓ Bookmarked</span>
                :readCopyOk
                  ?<span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:'#62c484',fontWeight:600,textAlign:'center'}}>✓ Copied to clipboard</span>
                  :<>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontFamily:FS,fontSize:12,color:T.gM,letterSpacing:'0.1em',fontWeight:600,flexShrink:0}}>
                        {(s=>{const a=[...s].sort((a,b)=>a-b);const r=[];let i=0;while(i<a.length){let j=i;while(j+1<a.length&&a[j+1]===a[j]+1)j++;r.push(j>i?`${a[i]}-${a[j]}`:String(a[i]));i=j+1;}return r.join(', ');})(readSelVerses)}
                      </span>
                      <input value={readBmLabel} onChange={e=>setReadBmLabel(e.target.value)} placeholder="Bookmark label…"
                        style={{flex:1,minWidth:0,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:8,color:T.body,fontFamily:FB,fontSize:15,padding:'8px 12px',outline:'none'}}/>
                      <button type="button" onClick={dismissStrip}
                        style={{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:18,flexShrink:0,padding:'4px 6px'}}>✕</button>
                    </div>
                    <div style={{display:'flex',gap:8}}>
                      <button type="button" className="s-btn s-ghost" onClick={copySelectedVerses}
                        title="Copy selected verse(s) to clipboard"
                        style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:8,color:T.dim,fontFamily:FS,fontSize:12,letterSpacing:'0.08em',padding:'10px 0',fontWeight:600,textAlign:'center'}}>
                        ⧉ Copy
                      </button>
                      {user
                        ?<button type="button" onClick={doReadBookmark}
                          style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:12,letterSpacing:'0.08em',padding:'10px 0',fontWeight:600,textAlign:'center',cursor:'pointer'}}>
                          ✦ Bookmark
                        </button>
                        :<span style={{flex:1,fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:14,textAlign:'center',padding:'10px 0'}}>Sign in to bookmark</span>}
                    </div>
                  </>
              }
            </div>
          )}

          {/* Bottom nav */}
          <div ref={bottomBarRef} className="bottom-nav-safe" style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,padding:'3px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',willChange:'transform'}}>
              <button type="button" className="s-btn s-ghost" onClick={readPrevCh} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',fontWeight:500,width:90,height:28,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {'\u2039'} {readCh>1?`Ch ${readCh-1}`:readBook>1?BIBLE.find(b=>b.n===readBook-1)?.name:''}
              </button>
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                <span style={{fontFamily:FS,fontSize:11,letterSpacing:'0.08em',color:T.gT,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',textTransform:'uppercase'}}>
                  {BIBLE.find(b=>b.n===readBook)?.name||''} {readCh}
                </span>
              </div>
              <button type="button" className="s-btn s-ghost" onClick={readNextCh} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',fontWeight:500,width:90,height:28,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {readCh<readTotalCh?`Ch ${readCh+1}`:readBook<66?BIBLE.find(b=>b.n===readBook+1)?.name:''} {'\u203a'}
              </button>
            </div>
        </div>
      )}

      {/* ═══ PARALLEL VERSES TAB ═══ */}
      {tab==='parallel'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          {/* Mobile nav sheet — now uses global nav via header button */}
          {/* Verse reference header */}
          <div style={{textAlign:'center',padding:'18px 14px 2px',flexShrink:0}}>
            <div style={{fontFamily:FS,fontSize:17,fontWeight:600,color:T.gT,letterSpacing:'0.08em'}}>
              {parallelBkData?.name} {parallelCh}:{parallelVs}
            </div>
            <div style={{height:1,background:T.accentLine,marginTop:8}}/>
          </div>
          {/* Version cards */}
          <div style={{flex:1,overflowY:'auto',padding:'8px 14px 72px',maxWidth:700,margin:'0 auto',width:'100%',boxSizing:'border-box'}}
            onTouchStart={e=>{swipeTouchX.current=e.touches[0].clientX;swipeTouchY.current=e.touches[0].clientY;swipeTouchT.current=Date.now();swipeDir.current=null;}}
            onTouchMove={e=>{
              if(swipeTouchX.current===null)return;
              const dx=e.touches[0].clientX-swipeTouchX.current;
              const dy=e.touches[0].clientY-swipeTouchY.current;
              if(!swipeDir.current&&(Math.abs(dx)>12||Math.abs(dy)>12)){swipeDir.current=Math.abs(dx)>Math.abs(dy)?'h':'v';}
            }}
            onTouchEnd={e=>{
              if(swipeTouchX.current===null)return;
              const wasH=swipeDir.current==='h';
              const dx=e.changedTouches[0].clientX-swipeTouchX.current;
              const dt=Math.max(1,Date.now()-swipeTouchT.current);
              const velocity=Math.abs(dx)/dt;
              swipeTouchX.current=null;swipeDir.current=null;
              if(!wasH)return;
              if(Math.abs(dx)<60&&velocity<0.35)return;
              if(dx<0)parallelNextVs();else parallelPrevVs();
            }}>
            {parallelLoading&&<div style={{textAlign:'center',padding:'32px 0',color:T.dim,fontFamily:FB,fontStyle:'italic'}}>Loading…</div>}
            {!parallelLoading&&parallelVids.map((vid,idx)=>{
              const verDef=(data?.versions||[]).find(v=>v.id===vid);
              const rows=parallelChapters[vid]||[];
              const verseRow=rows.find(r=>r.verse===parallelVs);
              const isFirst=idx===0;const isLast=idx===parallelVids.length-1;
              return(
                <div key={vid} style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:10,overflow:'hidden'}}>
                  <div style={{display:'flex',alignItems:'center',gap:6,padding:'7px 12px',borderBottom:`1px solid ${T.bdS}`,background:T.bgSec}}>
                    <span style={{flex:1,fontFamily:FS,fontSize:10,letterSpacing:'0.12em',fontWeight:600,color:T.gT}}>{verDef?.label||vid}</span>
                    <span style={{fontFamily:FS,fontSize:9,color:T.dim,letterSpacing:'0.08em'}}>{verDef?.lang}</span>
                    <button type="button" title="Move up" onClick={()=>setParallelVids(ids=>{const a=[...ids];[a[idx-1],a[idx]]=[a[idx],a[idx-1]];return a;})} disabled={isFirst}
                      style={{background:'none',border:'none',color:isFirst?T.dim:T.gM,cursor:isFirst?'default':'pointer',fontSize:16,padding:'0 3px',lineHeight:1}}>↑</button>
                    <button type="button" title="Move down" onClick={()=>setParallelVids(ids=>{const a=[...ids];[a[idx],a[idx+1]]=[a[idx+1],a[idx]];return a;})} disabled={isLast}
                      style={{background:'none',border:'none',color:isLast?T.dim:T.gM,cursor:isLast?'default':'pointer',fontSize:16,padding:'0 3px',lineHeight:1}}>↓</button>
                    <button type="button" title="Remove" onClick={()=>setParallelVids(ids=>ids.filter(id=>id!==vid))}
                      style={{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:14,padding:'0 3px',lineHeight:1}}>✕</button>
                  </div>
                  <div style={{padding:'13px 16px'}}>
                    {verseRow
                      ?<div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textAlign:readTextAlign}} dangerouslySetInnerHTML={{__html:processRedLetter(verseRow.text,readRedLetter,dark)}}/>
                      :<div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>Not available</div>}
                  </div>
                </div>
              );
            })}
            {/* Add removed versions back */}
            {(data?.versions||[]).filter(v=>!parallelVids.includes(v.id)).map(v=>(
              <button key={v.id} type="button" onClick={()=>setParallelVids(ids=>[...ids,v.id])}
                style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:'transparent',border:`1px dashed ${T.bd}`,borderRadius:9,color:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',padding:'10px 14px',cursor:'pointer',marginBottom:8,boxSizing:'border-box'}}>
                ＋ {v.label}
              </button>
            ))}
          </div>
          {/* Bottom nav */}
          <div className="bottom-nav-safe" style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,padding:'1px 12px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <button type="button" onClick={parallelPrevVs} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',padding:'6px 16px',fontWeight:500,cursor:'pointer'}}>
              ‹ Prev
            </button>
            <button type="button" className="show-mobile" onClick={()=>setParallelMobileSheet('nav')}
              style={{background:'none',border:'none',color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.2em',textTransform:'uppercase',fontWeight:500,cursor:'pointer',padding:'4px 8px'}}>
              {parallelVs} / {parallelTotalVs}
            </button>
            <span className="hide-mobile" style={{fontFamily:FS,fontSize:11,color:T.gT,letterSpacing:'0.2em',textTransform:'uppercase',fontWeight:500}}>
              {parallelVs} / {parallelTotalVs}
            </span>
            <button type="button" onClick={parallelNextVs} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',padding:'6px 16px',fontWeight:500,cursor:'pointer'}}>
              Next ›
            </button>
          </div>
        </div>
      )}

      {/* ═══ COMPARE TAB ═══ */}
      {tab==='compare'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div className="hide-mobile"><Legend T={T} refLabel={data.versions.find(v=>v.isRef)?.label}/></div>

          {/* Sticky controls */}
          <div className="no-print" style={{background:T.bgCard,borderBottom:`1px solid ${T.bd}`,position:'sticky',top:0,zIndex:50,flexShrink:0}}>

            {/* Search row — desktop only (mobile uses header) */}
            <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:5,padding:'5px 8px 4px'}}>
              <span style={{color:T.gM,fontSize:14,flexShrink:0}}>⌕</span>
              <input className="s-btn" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search passages, text, notes…"
                style={{flex:1,minWidth:0,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:14,padding:'5px 8px',outline:'none'}}/>
              {q&&<button type="button" className="s-btn s-ghost" title="Clear search" onClick={()=>setQ('')} style={{background:'none',border:'none',color:T.dim,fontSize:13,padding:'2px 4px',flexShrink:0}}>✕</button>}
              {/* Desktop: version toggles inline */}
              <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:4,flexShrink:0,marginLeft:4}}>
                <span style={{fontFamily:FS,fontSize:8.5,letterSpacing:'0.1em',textTransform:'uppercase',color:T.dim,fontWeight:500}}>Show:</span>
                {data.versions.map(v=>{const hidden=hiddenVers.includes(v.id);return(
                  <button key={v.id} type="button" className="s-btn s-tbtn" onClick={()=>togVer(v.id)}
                    style={{background:hidden?'transparent':T.gF,border:`1px solid ${hidden?T.bd:T.gD}`,borderRadius:5,color:hidden?T.dim:T.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'4px 9px',fontWeight:hidden?500:600,opacity:hidden?.5:1,textDecoration:hidden?'line-through':'none',transition:'all .15s'}}>
                    {v.label}
                  </button>);})}
              </div>
              {/* Mobile: ⚙ More button only */}
              <button type="button" className="s-btn s-ghost show-mobile" onClick={()=>setMobileSheet('compare')}
                style={{background:T.bgSec,border:`1px solid ${T.bdA}`,borderRadius:6,color:T.gM,fontFamily:FS,fontSize:9,letterSpacing:'0.06em',padding:'5px 10px',fontWeight:600,flexShrink:0,whiteSpace:'nowrap'}}>⚙ More</button>
            </div>

            {/* Actions row — desktop only (mobile uses header) */}
            <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:4,padding:'3px 8px 5px',borderTop:`1px solid ${T.bdS}`,flexWrap:'nowrap',overflowX:'auto',WebkitOverflowScrolling:'touch'}}>
              <TBtn T={T} ch="＋ Verse" onClick={openAdd} primary/>
              <TBtn T={T} ch="＋ Section" onClick={openAddSec}/>
              {/* Desktop extras — hidden on mobile */}
              <span className="hide-mobile"><TBtn T={T} ch="⚙ Versions" onClick={()=>setModal({type:'versions'})}/></span>
              <span className="hide-mobile"><TBtn T={T} ch="≡ Stats" onClick={()=>setModal({type:'stats'})}/></span>
              <span className="hide-mobile"><TBtn T={T} ch="↓ Export" onClick={doExport}/></span>
              <span className="hide-mobile"><TBtn T={T} ch="▾" onClick={()=>setSecToggle({action:'expand',tick:Date.now()})} title="Expand all"/></span>
              <span className="hide-mobile"><TBtn T={T} ch="▴" onClick={()=>setSecToggle({action:'collapse',tick:Date.now()})} title="Collapse all"/></span>
            </div>
            <FilterBar filters={filters} setFilters={setFilters} versions={data.versions} T={T} hiddenVers={hiddenVers} togVer={togVer} onExpand={()=>setSecToggle({action:'expand',tick:Date.now()})} onCollapse={()=>setSecToggle({action:'collapse',tick:Date.now()})}/>
          </div>

          {/* Compare actions bottom sheet (mobile) */}
          {mobileSheet==='compare'&&(
            <MobileSheet T={T} title={null} onClose={closeMobileSheet} isClosing={mobileSheetClosing} fromTop topOffset={navH}>
              <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textAlign:'center',marginBottom:14,textTransform:'uppercase'}}>Study Tools</div>
              {[
                {icon:'＋',label:'Add Section',fn:()=>{closeMobileSheet();openAddSec();}},
                {icon:'⚙',label:'Manage Versions',fn:()=>{closeMobileSheet();setModal({type:'versions'});}},
                {icon:'◎',label:'Statistics',fn:()=>{closeMobileSheet();setModal({type:'stats'});}},
                {icon:'⬇',label:'Export JSON',fn:()=>{closeMobileSheet();doExport();}},
              ].map(item=>(
                <button key={item.label} type="button" className="s-btn s-ghost" onClick={item.fn}
                  style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'12px 14px',width:'100%',marginBottom:5}}>
                  <span style={{width:20,textAlign:'center',color:T.gT,flexShrink:0,fontSize:14}}>{item.icon}</span>{item.label}
                </button>
              ))}
            </MobileSheet>
          )}

          {/* Compare search sheet (mobile) */}
          {mobileSheet==='compareSearch'&&(
            <MobileSheet T={T} title={null} onClose={closeMobileSheet} isClosing={mobileSheetClosing} fromTop topOffset={navH}>
              <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  <button type="button" onClick={closeMobileSheet}
                    style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    ←
                  </button>
                </div>
                <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Search</div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
                <input autoFocus value={q} onChange={e=>setQ(e.target.value)}
                  placeholder="Search passages, text, notes…"
                  style={{flex:1,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:15,padding:'8px 10px',outline:'none'}}/>
                {q&&<button type="button" onClick={()=>setQ('')} style={{background:'none',border:'none',color:T.dim,fontSize:14,cursor:'pointer',flexShrink:0,padding:'4px'}}>✕</button>}
              </div>
              {q&&<button type="button" onClick={closeMobileSheet}
                style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',fontWeight:600,padding:'8px 18px',cursor:'pointer',width:'100%'}}>
                View Results
              </button>}
            </MobileSheet>
          )}

          {/* Content */}
          <div style={{flex:1,overflowY:'auto'}}>
            <div className="cmp-area" style={{maxWidth:1120,margin:'0 auto',padding:'14px 14px 20px'}}>
              {hasFilter?(
                <>
                  <div style={{fontFamily:FS,fontSize:10,color:T.gM,letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:16,paddingBottom:12,borderBottom:`1px solid ${T.bd}`,fontWeight:600}}>{filtered.length} result{filtered.length!==1?'s':''}{q&&<span style={{color:T.dim,fontWeight:400}}> for "{q}"</span>}</div>
                  {filtered.length===0&&<div style={{textAlign:'center',padding:'48px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:16}}>No entries match.</div>}
                  {filtered.map((e,i)=><EntryCard key={e.id} entry={e} versions={visibleVersions} q={q} dark={dark} T={T} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulse={pulseId===e.id} idx={i} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>)}
                </>
              ):(
                data.sections.length===0
                  ?<div style={{textAlign:'center',padding:'64px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:16}}>No sections yet. Click + Section to add one.</div>
                  :data.sections.map((sec,si)=>(
                    <Section key={sec.id} sec={sec} entries={data.entries.filter(e=>e.sectionId===sec.id)} versions={visibleVersions} q={q} dark={dark} T={T} onEditSec={openEditSec} onDelSec={openDelSec} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulseId={pulseId} secToggle={secToggle} idx={si} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>
                  ))
              )}
              {!hasFilter&&data.entries.filter(e=>!data.sections.find(s=>s.id===e.sectionId)).map((e,i)=>(
                <EntryCard key={e.id} entry={e} versions={visibleVersions} q={q} dark={dark} T={T} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulse={pulseId===e.id} idx={i} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>
              ))}
            </div>
            <div className="no-print fade-in" style={{textAlign:'center',padding:'16px 24px 32px'}}>
              <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}>
                <div style={{flex:1,height:1,background:T.accentLine}}/><span style={{color:T.gD,fontSize:9}}>✦</span><div style={{flex:1,height:1,background:T.accentLine}}/>
              </div>
              <div style={{fontFamily:FB,fontStyle:'italic',fontSize:14,color:T.dim}}>All renderings should be verified against printed texts.</div>
              <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.2em',color:T.gD,textTransform:'uppercase',marginTop:6,fontWeight:500}}>To God Alone Be the Glory</div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STRONG'S CONCORDANCE TAB ═══ */}
      {tab==='strongs'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{padding:'12px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0}}>
            <input value={strongsSearchQ} onChange={e=>{
              const val=e.target.value;setStrongsSearchQ(val);setStrongsTabEntry(null);
              if(strongsSearchTimer.current)clearTimeout(strongsSearchTimer.current);
              strongsSearchTimer.current=setTimeout(()=>{
                const q=val.trim();
                if(q.length<2){setStrongsSearchRes(null);return;}
                setStrongsSearchLoading(true);
                dbSearchStrongs(q).then(r=>{setStrongsSearchRes(r);setStrongsSearchLoading(false);}).catch(()=>{setStrongsSearchRes([]);setStrongsSearchLoading(false);});
              },350);
            }} placeholder="Search by Strong's number (H430) or English word…" style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:15,padding:'10px 12px',outline:'none',boxSizing:'border-box'}}/>
            <div style={{fontFamily:FS,fontSize:8.5,color:T.dim,marginTop:6,letterSpacing:'0.08em'}}>
              {strongsSearchLoading?'SEARCHING…':strongsSearchRes?`${strongsSearchRes.length} RESULT${strongsSearchRes.length!==1?'S':''}`:strongsSearchQ.length>0&&strongsSearchQ.length<2?'TYPE AT LEAST 2 CHARACTERS':"STRONG'S CONCORDANCE · 14,197 ENTRIES"}
            </div>
          </div>

          {/* Entry detail view */}
          {strongsTabEntry&&strongsTabEntry.entry&&(
            <div style={{padding:'16px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0,overflow:'auto'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:T.gT,fontWeight:600}}>{strongsTabEntry.strongs_number}</span>
                <button onClick={()=>setStrongsTabEntry(null)} style={{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:16}}>✕</button>
              </div>
              <div style={{fontSize:28,color:T.body,marginBottom:4,fontFamily:'serif'}}>{strongsTabEntry.entry.original_word}</div>
              <div style={{fontFamily:FB,fontSize:15,color:T.mut,marginBottom:2}}>{strongsTabEntry.entry.transliteration}{strongsTabEntry.entry.pronunciation?` (${strongsTabEntry.entry.pronunciation})`:''}</div>
              <div style={{fontFamily:FB,fontSize:14,color:T.dim,marginBottom:10,fontStyle:'italic'}}>{strongsTabEntry.entry.language==='hebrew'?'Hebrew':'Greek'}</div>
              <div style={{fontFamily:FB,fontSize:16,color:T.body,lineHeight:1.5,marginBottom:10}}>{strongsTabEntry.entry.short_def}</div>
              {strongsTabEntry.entry.full_def&&<div style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.4,marginBottom:10}}>{strongsTabEntry.entry.full_def}</div>}
              {strongsTabEntry.entry.kjv_usage&&(
                <div style={{borderTop:`1px solid ${T.bd}`,paddingTop:8,marginTop:4}}>
                  <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',color:T.gM,marginBottom:4}}>KJV USAGE</div>
                  <div style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.4}}>{strongsTabEntry.entry.kjv_usage}</div>
                </div>
              )}
            </div>
          )}
          {strongsTabEntry&&!strongsTabEntry.entry&&(
            <div style={{padding:20,textAlign:'center',color:T.dim,fontFamily:FB}}>Loading...</div>
          )}

          {/* Search results list */}
          {strongsSearchRes&&strongsSearchRes.length>0&&!strongsTabEntry&&(
            <div style={{flex:1,overflow:'auto',padding:'6px 0'}}>
              {strongsSearchRes.map(r=>(
                <div key={r.strongs_number} onClick={()=>{
                  setStrongsTabEntry({strongs_number:r.strongs_number,entry:null});
                  dbGetStrongsEntry(r.strongs_number).then(entry=>{
                    setStrongsTabEntry(prev=>prev&&prev.strongs_number===r.strongs_number?{strongs_number:r.strongs_number,entry}:prev);
                  });
                }}
                  style={{padding:'10px 18px',cursor:'pointer',borderBottom:`1px solid ${T.bd}`,transition:'background .1s'}}
                  onMouseEnter={e=>e.currentTarget.style.background=T.gF}
                  onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:2}}>
                    <span style={{fontFamily:FS,fontSize:12,color:T.gT,fontWeight:600,letterSpacing:'0.06em'}}>{r.strongs_number}</span>
                    <span style={{fontFamily:'serif',fontSize:16,color:T.body}}>{r.original_word}</span>
                    <span style={{fontFamily:FB,fontSize:13,color:T.mut,fontStyle:'italic'}}>{r.transliteration}</span>
                  </div>
                  <div style={{fontFamily:FB,fontSize:13,color:T.dim,lineHeight:1.4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.short_def}</div>
                </div>
              ))}
            </div>
          )}
          {strongsSearchRes&&strongsSearchRes.length===0&&(
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:32}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.dim,textAlign:'center'}}>No results found for "{strongsSearchQ}"</div>
            </div>
          )}
          {!strongsSearchRes&&!strongsTabEntry&&(
            <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'32px 24px',textAlign:'center'}}>
              <div style={{width:56,height:56,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:14,color:T.gT,fontSize:26,marginBottom:18,fontFamily:FS}}>ℍ</div>
              <div style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>Strong's Concordance</div>
              <div style={{fontFamily:FB,fontSize:13,color:T.dim,maxWidth:290,lineHeight:1.7}}>Search by Strong's number (e.g. H430, G2316) or English definition.</div>
            </div>
          )}
        </div>
      )}

      {/* ═══ DICTIONARY TAB ═══ */}
      {tab==='dictionary'&&(function(){
        const posMap={'n':'noun','v':'verb','v.t':'verb transitive','v.i':'verb intransitive','adj':'adjective','adv':'adverb','prep':'preposition','conj':'conjunction','pron':'pronoun','interj':'interjection','art':'article','n.pl':'noun plural','p.p':'past participle','pret':'preterite','pp':'past participle','part':'participle','a':'adjective','n.':'noun','v.':'verb','adj.':'adjective','adv.':'adverb','prep.':'preposition','conj.':'conjunction','pron.':'pronoun','interj.':'interjection'};
        function expandPos(raw){if(!raw)return raw;const trimmed=raw.trim().toLowerCase().replace(/\.+$/,'');return posMap[trimmed]||posMap[raw.trim().toLowerCase()]||raw;}
        const q=dictSearchQ.trim().toLowerCase();
        const isLoading=dictDbLoading||dictLiveLoading;
        const hasDb=dictDbEntries&&dictDbEntries.length>0;
        const hasLive=dictLive&&dictLive.length>0;
        // Group DB results by word
        const grouped=hasDb?dictDbEntries.reduce((acc,e)=>{
          const w=e.word;if(!acc[w])acc[w]=[];acc[w].push(e);return acc;
        },{}):null;
        const groupedKeys=grouped?Object.keys(grouped).sort((a,b)=>{const al=a.toLowerCase(),bl=b.toLowerCase();const rankA=al===q?0:al.startsWith(q)?1:2;const rankB=bl===q?0:bl.startsWith(q)?1:2;if(rankA!==rankB)return rankA-rankB;return al.localeCompare(bl);}):[];
        const statusLabel=isLoading?'LOOKING UP…':hasDb?`WEBSTER'S 1828 · ${groupedKeys.length} WORD${groupedKeys.length!==1?'S':''} · ${dictDbEntries.length} ENTR${dictDbEntries.length!==1?'IES':'Y'}`:hasLive?'EXTERNAL SOURCE':!q?'WEBSTER\'S 1828 · 107,793 ENTRIES':q.length<2?'TYPE AT LEAST 2 CHARACTERS':'NO RESULTS FOUND';
        return(
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
            <div style={{padding:'12px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0}}>
              <input value={dictSearchQ} onChange={e=>{setDictSearchQ(e.target.value);setDictLive(null);setDictDbEntries(null);}} placeholder="Search Webster's 1828…" style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:15,padding:'10px 12px',outline:'none',boxSizing:'border-box'}}/>
              <div style={{fontFamily:FS,fontSize:8.5,color:T.dim,marginTop:6,letterSpacing:'0.08em'}}>{statusLabel}</div>
            </div>
            {/* DB results grouped by word then POS */}
            {hasDb&&(
              <div style={{flex:1,overflow:'auto',padding:'6px 0'}}>
                {groupedKeys.map(word=>{
                  const entries=grouped[word];
                  return(
                    <div key={word} style={{borderBottom:`1px solid ${T.bdS}`}}>
                      <div style={{padding:'12px 18px 6px',display:'flex',alignItems:'center',gap:8}}>
                        <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*1.05),color:T.gT,fontWeight:600}}>{word.toLowerCase()}</span>
                        <span style={{fontFamily:FS,fontSize:7,letterSpacing:'0.1em',color:T.gM,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:3,padding:'1px 5px',flexShrink:0}}>1828</span>
                      </div>
                      {entries.map((e,ei)=>(
                        <div key={ei} style={{padding:'4px 18px 10px'}}>
                          <div style={{fontFamily:FB,fontSize:Math.round(readFontSize*0.65),color:T.dim,fontStyle:'italic',marginBottom:4}}>{expandPos(e.pos)}</div>
                          {(e.definitions||[]).map((def,di)=>(
                            <div key={di} style={{display:'flex',gap:6,marginBottom:4}}>
                              <span style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.55),color:T.gM,minWidth:14,textAlign:'right',flexShrink:0,paddingTop:2}}>{di+1}.</span>
                              <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.mut,lineHeight:readLineHeight}}>{def}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Loading */}
            {isLoading&&!hasDb&&(
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:10}}>
                <Spinner/><div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.1em',color:T.dim,marginTop:4}}>LOOKING UP…</div>
              </div>
            )}
            {/* External API fallback results */}
            {!isLoading&&!hasDb&&hasLive&&(
              <div style={{flex:1,overflow:'auto',padding:'6px 0'}}>
                <div style={{padding:'6px 18px 10px',display:'flex',alignItems:'center',gap:6}}>
                  <span style={{fontFamily:FS,fontSize:7.5,letterSpacing:'0.1em',color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:3,padding:'2px 6px'}}>EXTERNAL SOURCE</span>
                  <span style={{fontFamily:FB,fontSize:10,color:T.dim}}>Not found in Webster's 1828</span>
                </div>
                {dictLive.map((entry,ei)=>(
                  <div key={ei}>
                    {(entry.meanings||[]).map((m,mi)=>(
                      <div key={mi}>
                        <div style={{padding:'10px 18px 6px',background:T.bgSec,borderBottom:`1px solid ${T.bd}`,display:'flex',alignItems:'center',gap:8}}>
                          <span style={{fontFamily:FB,fontSize:readFontSize,color:T.gT,fontWeight:500}}>{entry.word}</span>
                          <span style={{fontFamily:FB,fontSize:Math.round(readFontSize*0.7),color:T.dim,fontStyle:'italic'}}>{expandPos(m.partOfSpeech)}</span>
                        </div>
                        {(m.definitions||[]).slice(0,4).map((d,di)=>(
                          <div key={di} style={{padding:'10px 18px',borderBottom:`1px solid ${T.bdS}`}}>
                            <div style={{display:'flex',gap:6,marginBottom:2}}>
                              <span style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.55),color:T.gM,minWidth:14,textAlign:'right',flexShrink:0,paddingTop:2}}>{di+1}.</span>
                              <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.mut,lineHeight:readLineHeight}}>{d.definition}</span>
                            </div>
                            {d.example&&<div style={{fontFamily:FB,fontSize:Math.round(readFontSize*0.7),color:T.dim,marginTop:3,fontStyle:'italic',paddingLeft:22,borderLeft:`2px solid ${T.gD}`,marginLeft:14}}>"{d.example}"</div>}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {/* Empty state / no results */}
            {!isLoading&&!hasDb&&!hasLive&&(
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:'32px 24px',textAlign:'center'}}>
                <div style={{fontFamily:FB,fontSize:14,color:T.dim,maxWidth:290}}>
                  {!q?'Search for any English word in Webster\'s 1828 Dictionary.':q.length<2?'Type at least 2 characters to search.':'No definition found for "'+dictSearchQ+'".'}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ MAPS TAB ═══ */}
      {tab==='maps'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'32px 24px',textAlign:'center'}}>
            <div style={{width:56,height:56,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:14,color:T.gT,fontSize:26,marginBottom:18}}><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg></div>
            <div style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>Maps</div>
            <div style={{fontFamily:FB,fontSize:13,color:T.dim,maxWidth:290,lineHeight:1.7}}>Biblical maps and geography are coming soon.</div>
            <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.dim,textTransform:'uppercase',marginTop:18,opacity:0.5}}>COMING SOON</div>
          </div>
        </div>
      )}

      {/* ═══ CHARTS TAB ═══ */}
      {tab==='charts'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'32px 24px',textAlign:'center'}}>
            <div style={{width:56,height:56,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:14,color:T.gT,fontSize:26,marginBottom:18,fontFamily:FS}}>▦</div>
            <div style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>Charts</div>
            <div style={{fontFamily:FB,fontSize:13,color:T.dim,maxWidth:290,lineHeight:1.7}}>Timelines and visual references are coming soon.</div>
            <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.dim,textTransform:'uppercase',marginTop:18,opacity:0.5}}>COMING SOON</div>
          </div>
        </div>
      )}

      {/* ═══ OTHER RESOURCES TAB ═══ */}
      {tab==='other'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'32px 24px',textAlign:'center'}}>
            <div style={{width:56,height:56,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:14,color:T.gT,fontSize:26,marginBottom:18,fontFamily:FS}}>⋯</div>
            <div style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>Other Resources</div>
            <div style={{fontFamily:FB,fontSize:13,color:T.dim,maxWidth:290,lineHeight:1.7}}>Additional study materials are coming soon.</div>
            <div style={{fontFamily:FS,fontSize:8,letterSpacing:'0.14em',color:T.dim,textTransform:'uppercase',marginTop:18,opacity:0.5}}>COMING SOON</div>
          </div>
        </div>
      )}

      {/* ═══ MODALS ═══ */}
      {modal?.type==='entry'&&<EntryModal entry={modal.entry} sections={data.sections} versions={data.versions} onSave={saveEntry} onClose={()=>setModal(null)} T={T} dark={dark}/>}
      {modal?.type==='section'&&<SecModal sec={modal.sec} onSave={saveSec} onClose={()=>setModal(null)} T={T}/>}
      {modal?.type==='delete'&&(
        <ConfirmDialog T={T} danger={modal.delType==='entry'}
          title={`Delete ${modal.delType}?`}
          message={modal.delType==='section'&&data.entries.some(e=>e.sectionId===modal.delId)
            ?`This section has ${data.entries.filter(e=>e.sectionId===modal.delId).length} entries. Move or delete them first.`
            :`Permanently delete this ${modal.delType}? You can undo for 8 seconds.`}
          confirmLabel={modal.delType==='section'&&data.entries.some(e=>e.sectionId===modal.delId)?undefined:'✕ Delete'}
          cancelLabel={modal.delType==='section'&&data.entries.some(e=>e.sectionId===modal.delId)?'OK':'Cancel'}
          onConfirm={confirmDel} onCancel={()=>setModal(null)}/>
      )}
      {modal?.type==='versions'&&<VersionsModal data={data} onSave={saveVersions} onClose={()=>setModal(null)} T={T} dlStates={dlStates} onDownload={startDownload} onDeleteLocal={deleteDownload}/>}
      {modal?.type==='bookmarks'&&<BookmarksPanel T={T} bookmarks={bookmarks} onDelete={handleDelBookmark} onOpen={openFromBookmark} onClose={()=>setModal(null)} versions={data.versions}/>}
      {modal?.type==='recents'&&<RecentsPanel T={T} recents={recents} onOpen={openFromRecent} onClose={()=>setModal(null)} versions={data.versions}/>}
      {modal?.type==='stats'&&<StatsModal data={data} T={T} onClose={()=>setModal(null)}/>}
      {modal?.type==='reset'&&<ResetConfirmModal T={T} onConfirm={doReset} onCancel={()=>setModal(null)} entryCount={data.entries.length} sectionCount={data.sections.length}/>}
      {modal?.type==='help'&&(
        <Modal title="Help & Reference" onClose={()=>setModal(null)} wide T={T} footer={<><PBtn ch="⚠ Reset to Defaults" onClick={()=>setModal({type:'reset'})} T={T} danger sm/><SBtn ch="Close" onClick={()=>setModal(null)} T={T}/></>}>
          <div style={{fontFamily:FB,fontSize:15,color:T.mut,lineHeight:1.9}}>
            <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:6,fontWeight:600}}>Read Tab</div>
            The default home. Choose a version, book, chapter, and verse. Tap any verse to select it and bookmark it. Use the search bar to find phrases across the current version.<br/><br/>
            <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:6,marginTop:14,fontWeight:600}}>Compare Tab</div>
            Add study entries (passage + per-version text + issue labels). Use filters and search to navigate. The 📖 icon on any card jumps to that chapter in the Read tab.<br/><br/>
            <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:6,marginTop:14,fontWeight:600}}>Auto-fill</div>
            In the entry editor, pick Book/Chapter/Verse then click <strong style={{color:T.gT}}>⚡ Auto-fill</strong> to pull verse text from the database for all versions simultaneously.<br/><br/>
            <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:6,marginTop:14,fontWeight:600}}>Requesting Versions</div>
            To request a new Bible version or translation, contact the app creator. Existing versions can be managed via Compare &gt; Versions.<br/><br/>
            <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:6,marginTop:14,fontWeight:600}}>Shortcuts</div>
            <code style={{fontFamily:'monospace',background:T.bgSec,padding:'2px 6px',borderRadius:3,fontSize:13}}>Ctrl/⌘+Z</code> Undo delete &nbsp;&middot;&nbsp; <code style={{fontFamily:'monospace',background:T.bgSec,padding:'2px 6px',borderRadius:3,fontSize:13}}>Esc</code> Close modal
          </div>
        </Modal>
      )}

      <UndoToast ud={undo} onUndo={doUndo} onDismiss={dismissUndo} T={T}/>
    </div>
  );
}

export default App;
