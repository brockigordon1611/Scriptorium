import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Browser } from '@capacitor/browser';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App as CapApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { LocalNotifications } from '@capacitor/local-notifications';
import { MEEK_WEEKS } from './meekPlan.js';
import { cmtiToMarkup, dropSelfLine, markupRuns } from './commentary.js';

// ── Boot timeline ──
// What the app did as it started and when, kept for the last few launches in
// localStorage ('scrip:boot'). A slow start on a phone happens where no console
// can see it; this lets it be read back off the device afterwards. Times are ms
// since the page began loading; `at` is the wall clock at that moment.
const BOOT={at:Date.now()-Math.round(typeof performance!=='undefined'?performance.now():0),marks:[],errors:[]};
function bootSave(){try{const all=JSON.parse(localStorage.getItem('scrip:boot')||'[]').filter(b=>b.at!==BOOT.at);all.unshift(BOOT);localStorage.setItem('scrip:boot',JSON.stringify(all.slice(0,6)));}catch{}}
function bootMark(name,detail){
  try{
    if(BOOT.marks.length>80)return;
    const m=[name,Math.round(performance.now())];
    if(detail!==undefined)m.push(String(detail).slice(0,200));
    if(typeof document!=='undefined'&&document.visibilityState!=='visible')m.push('hidden');
    BOOT.marks.push(m);bootSave();
  }catch{}
}
if(typeof window!=='undefined'){
  window.addEventListener('error',e=>{BOOT.errors.push([Math.round(performance.now()),String(e.message||e.error).slice(0,300)]);bootSave();});
  window.addEventListener('unhandledrejection',e=>{BOOT.errors.push([Math.round(performance.now()),String(e.reason&&e.reason.message||e.reason).slice(0,300)]);bootSave();});
  document.addEventListener('visibilitychange',()=>bootMark(document.visibilityState));
}
bootMark('js');

// Opens a link without leaving the app. On device this is an in-app Safari
// sheet with a Done button that returns to the exact spot; the FCBH download
// used to hand the user to Safari and leave them to find their own way back.
// On the web it stays an ordinary new tab.
function openExternal(url){
  if(Capacitor.isNativePlatform())Browser.open({url,presentationStyle:'popover'}).catch(()=>{window.open(url,'_blank','noreferrer');});
  else window.open(url,'_blank','noreferrer');
}

// Some in-app browsers ship no speech synthesis at all — Facebook's and
// Instagram's on Android among them. A bare `TTS` reference is a
// ReferenceError when the global is missing, not undefined, so it threw during
// the first render and took the whole app down with a startup error. Every use
// goes through these instead, which degrade to doing nothing.
const TTS_OK=typeof window!=='undefined'&&!!window.speechSynthesis&&typeof window.SpeechSynthesisUtterance==='function';
const TTS=(typeof window!=='undefined'&&window.speechSynthesis)||{
  getVoices:()=>[],cancel(){},pause(){},resume(){},speak(){},
  addEventListener(){},removeEventListener(){},paused:false,speaking:false,pending:false,
};
const SpeechUtter=(typeof window!=='undefined'&&window.SpeechSynthesisUtterance)||function(text){this.text=text;};
// Older WebViews have no ResizeObserver. Both uses are in mount effects, so a
// bare reference would throw during startup exactly the way speechSynthesis did;
// the window resize listener beside them already covers the common case.
const RObserver=(typeof window!=='undefined'&&window.ResizeObserver)||class{observe(){}unobserve(){}disconnect(){}};



/* ══════════════════════════════════════════════════════════════
   SCRIPTORIUM v2  ✦  Bible Study & Comparison Tool
   "The words of the LORD are pure words: as silver tried
    in a furnace of earth, purified seven times." — Psalm 12:6
   ══════════════════════════════════════════════════════════════ */

// ── Supabase config ───────────────────────────────────────
const SUPA_URL  = import.meta.env.VITE_SUPA_URL;
const SUPA_ANON = import.meta.env.VITE_SUPA_ANON;

const SB_KEY = `sb-garuwsjczcptykehgjdx-auth-token`;

function sbHeaders(token) {
  return {
    "Content-Type": "application/json",
    "apikey": SUPA_ANON,
    "Authorization": `Bearer ${token || SUPA_ANON}`,
  };
}
function getToken() {
  try { const s = JSON.parse(localStorage.getItem(SB_KEY)||'null'); return s?.access_token||null; } catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem(SB_KEY, JSON.stringify(s));
  else localStorage.removeItem(SB_KEY);
}

// ── REST helpers ──────────────────────────────────────────
function sbSignal(ms=8000){const ac=new AbortController();setTimeout(()=>ac.abort(),ms);return ac.signal;}

// An access token lives an hour. Only Auth.getSession refreshes one, and that
// runs once at startup, so every request made by an app left open past the hour
// carried a dead token. PostgREST answers those with 401 and an error object
// rather than rows, which the callers below then read as "no results" or, on an
// insert, as a row — which is where bookmarks saved as undefined came from.
//
// So a 401 is taken here as what it almost always is — an expired token, not a
// refused one — and the request is retried once on a fresh one. Refreshing on a
// timer alone would not do: the app can sit backgrounded for days.
async function sbFetch(url, init, token) {
  let r = await fetch(url, init);
  if (r.status === 401 && token) {
    const fresh = await Auth.refresh();
    if (fresh && fresh.access_token && fresh.access_token !== token) {
      r = await fetch(url, {...init, headers:{...(init.headers||{}), Authorization:`Bearer ${fresh.access_token}`}, signal: sbSignal()});
    }
  }
  return r;
}
// A failed request has no rows. Returning [] for a read and [error] for a write
// is what let both failures pass for success.
async function sbBody(r) {
  let d = null;
  try { d = await r.json(); } catch {}
  if (!r.ok) return { data: [], error: d || {status:r.status} };
  return { data: Array.isArray(d) ? d : (d==null ? [] : [d]), error: null };
}
async function sbFrom(table, token) {
  const hdrs = sbHeaders(token);
  const base = `${SUPA_URL}/rest/v1/${table}`;
  return {
    async select(cols, filters={}, opts={}) {
      let url = `${base}?select=${encodeURIComponent(cols||'*')}`;
      for (const [k,v] of Object.entries(filters)) url += `&${k}=eq.${encodeURIComponent(v)}`;
      if (opts.order) url += `&order=${opts.order}`;
      if (opts.limit) url += `&limit=${opts.limit}`;
      const r = await sbFetch(url, { headers: hdrs, signal: sbSignal() }, token);
      return sbBody(r);
    },
    async insert(rows) {
      const body = Array.isArray(rows)?rows:[rows];
      const r = await sbFetch(base, { method:'POST', headers:{...hdrs,'Prefer':'return=representation'}, body:JSON.stringify(body), signal: sbSignal() }, token);
      return sbBody(r);
    },
    async upsert(rows) {
      const body = Array.isArray(rows)?rows:[rows];
      const r = await sbFetch(base, { method:'POST', headers:{...hdrs,'Prefer':'return=representation,resolution=merge-duplicates'}, body:JSON.stringify(body), signal: sbSignal() }, token);
      return sbBody(r);
    },
    async update(vals, filters={}) {
      let url = `${base}?`;
      for (const [k,v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;
      const r = await sbFetch(url, { method:'PATCH', headers:{...hdrs,'Prefer':'return=representation'}, body:JSON.stringify(vals), signal: sbSignal() }, token);
      return sbBody(r);
    },
    async delete(filters={}) {
      let url = `${base}?`;
      for (const [k,v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;
      const r = await sbFetch(url, { method:'DELETE', headers:hdrs, signal: sbSignal() }, token);
      return { error: r.ok?null:await r.json().catch(()=>({status:r.status})) };
    },
  };
}

async function sbRpc(func, params, token) {
  const r = await sbFetch(`${SUPA_URL}/rest/v1/rpc/${func}`, {
    method:'POST', headers: sbHeaders(token), body: JSON.stringify(params), signal: sbSignal()
  }, token);
  let d = null;
  try { d = await r.json(); } catch {}
  // The verse search runs through here: handing back the error as data is what
  // turned an expired token into "no results found".
  return { data: r.ok ? d : null, error: r.ok ? null : (d || {status:r.status}) };
}

// ── Auth ──────────────────────────────────────────────────
const authListeners = [];
let refreshInFlight = null;
const Auth = {
  // Forced, unlike getSession's, which only refreshes once the clock says the
  // token has expired — a 401 means it is dead whatever the clock says. Shared
  // between callers so a screen that fires six requests at once refreshes once,
  // and so five of them do not race to spend a refresh token that can only be
  // spent by one.
  async refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const raw = localStorage.getItem(SB_KEY);
        const s = raw ? JSON.parse(raw) : null;
        if (!s || !s.refresh_token) return null;
        const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
          method:'POST', headers: sbHeaders(null),
          body: JSON.stringify({ refresh_token: s.refresh_token }), signal: sbSignal(8000)
        });
        if (!r.ok) {
          // A refused refresh token is a session that is genuinely over; keeping
          // it would retry a dead token on every request from here on.
          if (r.status === 400 || r.status === 401) { saveSession(null); authListeners.forEach(fn => fn(null)); }
          return null;
        }
        const ns = await r.json();
        if (!ns || !ns.access_token) return null;
        saveSession(ns);
        return ns;
      } catch { return null; }
      // Cleared as soon as it settles, not a tick later: everyone who asked
      // while it was in flight already holds this promise, and anyone asking
      // afterwards wants a real refresh rather than this one's answer.
      finally { refreshInFlight = null; }
    })();
    return refreshInFlight;
  },
  async getSession() {
    try {
      const raw = localStorage.getItem(SB_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.expires_at && Date.now()/1000 > s.expires_at - 60) {
        try {
          const ac = new AbortController();
          const tid = setTimeout(()=>ac.abort(), 5000);
          const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
            method:'POST', headers: sbHeaders(null), body: JSON.stringify({ refresh_token: s.refresh_token }), signal: ac.signal
          });
          clearTimeout(tid);
          if (r.ok) { const ns = await r.json(); saveSession(ns); return ns; }
          saveSession(null); return null;
        } catch { return s; }
      }
      return s;
    } catch { return null; }
  },
  async signIn(email, password) {
    const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
      method:'POST', mode:'cors', headers: sbHeaders(null), body: JSON.stringify({ email, password })
    });
    const d = await r.json();
    if (!r.ok) return { error: d.error_description || d.msg || d.message || 'Auth error '+r.status };
    saveSession(d);
    authListeners.forEach(fn => fn(d.user));
    return { user: d.user };
  },
  async signUp(email, password) {
    const r = await fetch(`${SUPA_URL}/auth/v1/signup`, {
      method:'POST', mode:'cors', headers: sbHeaders(null), body: JSON.stringify({ email, password })
    });
    const d = await r.json();
    if (!r.ok) return { error: d.error_description || d.msg || d.message || 'Auth error '+r.status };
    if (d.user && d.access_token) { saveSession(d); authListeners.forEach(fn => fn(d.user)); }
    return { user: d.user, needsConfirm: !d.access_token };
  },
  async signOut() {
    const token = getToken();
    if (token) await fetch(`${SUPA_URL}/auth/v1/logout`, { method:'POST', headers: sbHeaders(token) });
    saveSession(null);
    authListeners.forEach(fn => fn(null));
  },
  async resetPassword(email) {
    const r = await fetch(`${SUPA_URL}/auth/v1/recover`, {
      method:'POST', mode:'cors', headers: sbHeaders(null), body: JSON.stringify({ email })
    });
    if (!r.ok) { const d = await r.json(); return { error: d.error_description || d.msg || d.message || 'Error '+r.status }; }
    return { ok: true };
  },
  async updatePassword(newPassword) {
    const token = getToken();
    if (!token) return { error: 'Not authenticated.' };
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      method:'PUT', mode:'cors', headers: sbHeaders(token), body: JSON.stringify({ password: newPassword })
    });
    const d = await r.json();
    if (!r.ok) return { error: d.error_description || d.msg || d.message || 'Error '+r.status };
    return { ok: true };
  },
  async deleteAccount() {
    const token = getToken();
    if (!token) return { error: 'Not authenticated.' };
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/delete_my_account`, {
      method:'POST', headers: sbHeaders(token), body: JSON.stringify({})
    });
    if (!r.ok) { const d = await r.json().catch(()=>{}); return { error: d?.message || 'Error '+r.status }; }
    saveSession(null);
    authListeners.forEach(fn => fn(null));
    return { ok: true };
  },
  onAuthChange(fn) { authListeners.push(fn); return () => { const i=authListeners.indexOf(fn); if(i>=0) authListeners.splice(i,1); }; }
};


// ══════════════════════════════════════════════════════════
//  LOCAL-FIRST: IndexedDB Bible text cache
// ══════════════════════════════════════════════════════════
const IDB_NAME='scriptorium';
const IDB_VER=8;
let _idbInst=null,_idbOpening=null;

function idbOpen(){
  if(_idbInst)return Promise.resolve(_idbInst);
  // Everything at startup asks at once; they share the one open rather than
  // each opening a connection of its own.
  if(_idbOpening)return _idbOpening;
  // Private-browsing modes can leave this undefined; reject so callers take
  // their existing error paths instead of throwing out of the promise.
  const idb=typeof window!=='undefined'?window.indexedDB:null;
  if(!idb)return Promise.reject(new Error('IndexedDB unavailable'));
  return _idbOpening=new Promise((resolve,reject)=>{
    const req=idb.open(IDB_NAME,IDB_VER);
    bootMark('idb-open-start');
    // Another holder of an older version keeps an upgrade waiting; say so.
    req.onblocked=()=>bootMark('idb-blocked');
    req.onupgradeneeded=e=>{
      bootMark('idb-upgrade',`${e.oldVersion}->${e.newVersion}`);
      const db=e.target.result;
      // v1 stores
      if(!db.objectStoreNames.contains('verses')){
        const vs=db.createObjectStore('verses',{keyPath:'pk'});
        vs.createIndex('by_chapter',['version_id','book_num','chapter'],{unique:false});
      }
      if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'});
      // v2 stores
      if(!db.objectStoreNames.contains('strongs_lex')){
        const sl=db.createObjectStore('strongs_lex',{keyPath:'strongs_number'});
        sl.createIndex('word_lower','word_lower',{unique:false});
      }
      if(!db.objectStoreNames.contains('webster')){
        const wb=db.createObjectStore('webster',{autoIncrement:true});
        wb.createIndex('word_lower','word_lower',{unique:false});
      }
      // v3 stores
      if(!db.objectStoreNames.contains('resources')){
        db.createObjectStore('resources',{keyPath:'id'});
      }
      // v4 stores — binary blobs for images, PDFs, SQLite chapter data
      if(!db.objectStoreNames.contains('resource_blobs')){
        db.createObjectStore('resource_blobs',{keyPath:'id'});
      }
      // v5 store — Strong's word mapping, keyed 'book|chapter'
      if(!db.objectStoreNames.contains('strongs_map')){
        db.createObjectStore('strongs_map',{keyPath:'pk'});
      }
      // v6 store — KJV occurrences, keyed by Strong's number
      if(!db.objectStoreNames.contains('strongs_occ')){
        db.createObjectStore('strongs_occ',{keyPath:'sn'});
      }
      // v7 store — build scratch: KJV word per Strong's number per verse
      if(!db.objectStoreNames.contains('strongs_kjvw')){
        db.createObjectStore('strongs_kjvw',{keyPath:'sn'});
      }
      // v8 stores — commentaries, one record per chapter keyed 'id|book|chapter'
      // (chapter 0 is the book's introduction), and the list of the reader's own
      if(!db.objectStoreNames.contains('commentary')){
        const cm=db.createObjectStore('commentary',{keyPath:'pk'});
        cm.createIndex('by_cid','cid',{unique:false});
      }
      if(!db.objectStoreNames.contains('commentaries')){
        db.createObjectStore('commentaries',{keyPath:'id'});
      }
    };
    req.onsuccess=e=>{
      bootMark('idb-open');
      _idbInst=e.target.result;
      // Another tab opening a newer version waits on this one until it lets go.
      _idbInst.onversionchange=()=>{try{_idbInst.close();}catch{}_idbInst=null;};
      _idbOpening=null;
      resolve(_idbInst);
    };
    req.onerror=e=>{bootMark('idb-error',e.target.error&&e.target.error.message);_idbOpening=null;reject(e.target.error);};
  });
}
function _idbReq(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});}
// A write is done when its transaction completes. One that aborts -- which is
// what a write refused for space does, with no error event -- has to fail too,
// or whoever awaits it waits for good: that is how the bundled install could
// hold the loading screen up indefinitely.
function _txDone(tx){
  return new Promise((res,rej)=>{
    tx.oncomplete=()=>res();
    tx.onerror=e=>rej(e.target.error||tx.error||new Error('IndexedDB write failed'));
    tx.onabort=()=>rej(tx.error||new Error('IndexedDB write aborted'));
  });
}

// ── Bible verses ──────────────────────────────────────────
async function idbGetChapterLocal(versionId,bookNum,chapter){
  const db=await idbOpen();
  const rows=await _idbReq(db.transaction('verses','readonly').objectStore('verses').index('by_chapter').getAll([versionId,bookNum,chapter]));
  return rows.sort((a,b)=>a.verse-b.verse);
}
async function idbSearchLocal(versionId,bookMin,bookMax){
  const db=await idbOpen();
  return new Promise((resolve,reject)=>{
    const range=IDBKeyRange.bound([versionId,bookMin,0],[versionId,bookMax,9999]);
    const req=db.transaction('verses','readonly').objectStore('verses').index('by_chapter').getAll(range);
    req.onsuccess=e=>resolve(e.target.result||[]);
    req.onerror=e=>reject(e.target.error);
  });
}
async function idbPutVerses(versionId,rows){
  const db=await idbOpen();
  const tx=db.transaction('verses','readwrite');
  const st=tx.objectStore('verses');
  for(const r of rows)st.put({pk:`${versionId}|${r.book_num}|${r.chapter}|${r.verse}`,version_id:versionId,book_num:r.book_num,chapter:r.chapter,verse:r.verse,text:r.text});
  return _txDone(tx);
}

// ── Strong's lexicon ──────────────────────────────────────
async function idbGetStrongsEntryLocal(num){
  const db=await idbOpen();
  return _idbReq(db.transaction('strongs_lex','readonly').objectStore('strongs_lex').get(num));
}
async function idbSearchStrongsLocal(query){
  const db=await idbOpen();
  const q=query.toLowerCase();
  const qUp=query.toUpperCase();
  const seen=new Set();
  const results=[];
  function addEntry(v){if(!seen.has(v.strongs_number)){seen.add(v.strongs_number);results.push(v);}}
  // 1. word_lower prefix via index cursor (fast — transliteration searches)
  await new Promise((res,rej)=>{
    const range=IDBKeyRange.bound(q,q+'\uffff');
    const req=db.transaction('strongs_lex','readonly').objectStore('strongs_lex').index('word_lower').openCursor(range);
    req.onsuccess=e=>{const c=e.target.result;if(c&&results.length<40){addEntry(c.value);c.continue();}else res();};
    req.onerror=e=>rej(e.target.error);
  });
  // 2. strongs_number prefix via PK cursor (fast — H123 / G456 lookups)
  if(results.length<40){
    await new Promise((res,rej)=>{
      const range=IDBKeyRange.bound(qUp,qUp+'\uffff');
      const req=db.transaction('strongs_lex','readonly').objectStore('strongs_lex').openCursor(range);
      req.onsuccess=e=>{const c=e.target.result;if(c&&results.length<40){addEntry(c.value);c.continue();}else res();};
      req.onerror=e=>rej(e.target.error);
    });
  }
  // 3. short_def contains (streaming cursor — only runs when steps 1+2 returned few results)
  if(results.length<20){
    await new Promise((res,rej)=>{
      const req=db.transaction('strongs_lex','readonly').objectStore('strongs_lex').openCursor();
      req.onsuccess=e=>{
        const c=e.target.result;
        if(c&&results.length<40){
          if(c.value.short_def&&c.value.short_def.toLowerCase().includes(q))addEntry(c.value);
          c.continue();
        }else res();
      };
      req.onerror=e=>rej(e.target.error);
    });
  }
  return results;
}
async function idbPutStrongsEntries(rows){
  const db=await idbOpen();
  const tx=db.transaction('strongs_lex','readwrite');
  const st=tx.objectStore('strongs_lex');
  for(const r of rows)st.put({...r,word_lower:(r.transliteration||r.short_def||'').toLowerCase()});
  return _txDone(tx);
}
async function idbClearStrongs(){
  const db=await idbOpen();
  const tx=db.transaction(['strongs_lex','strongs_map','strongs_occ','strongs_kjvw'],'readwrite');
  tx.objectStore('strongs_lex').clear();
  tx.objectStore('strongs_map').clear();
  tx.objectStore('strongs_occ').clear();
  tx.objectStore('strongs_kjvw').clear();
  return _txDone(tx);
}
// Strong's word mapping is 785,856 rows. Storing one IndexedDB record per word
// would be punishingly slow to write and read, so we group by chapter — 1,189
// records — with compact tuples [verse, word_pos, word_text, strongs_num].
async function idbPutStrongsMapChapters(records){
  const db=await idbOpen();
  const tx=db.transaction('strongs_map','readwrite');
  const st=tx.objectStore('strongs_map');
  for(const rec of records)st.put(rec);
  return _txDone(tx);
}
async function idbPutStrongsOcc(records){
  const db=await idbOpen();
  const tx=db.transaction('strongs_occ','readwrite');
  const st=tx.objectStore('strongs_occ');
  for(const rec of records)st.put(rec);
  return _txDone(tx);
}
// Expand back into the exact shape get_strongs_verses returns, so the popup and
// the Strong's tab render identically whether the data came from here or the server.
async function idbGetStrongsOccLocal(sn){
  const db=await idbOpen();
  const rec=await _idbReq(db.transaction('strongs_occ','readonly').objectStore('strongs_occ').get(sn));
  if(!rec||!Array.isArray(rec.refs))return null;
  const total=rec.total??rec.refs.length;
  return rec.refs.map(([book_num,chapter,verse,word_text,verse_count])=>({book_num,chapter,verse,word_text,verse_count,total_count:total}));
}
async function idbGetStrongsMapChapter(bookNum,chapter){
  const db=await idbOpen();
  const rec=await _idbReq(db.transaction('strongs_map','readonly').objectStore('strongs_map').get(`${bookNum}|${chapter}`));
  if(!rec||!Array.isArray(rec.rows))return null;
  return rec.rows.map(([verse,word_pos,word_text,strongs_num])=>({verse,word_pos,word_text,strongs_num}));
}

// ── Webster's 1828 ────────────────────────────────────────
async function idbSearchWebsterLocal(query){
  const db=await idbOpen();
  const q=query.toLowerCase();
  // Range query: all words starting with query, plus exact matches anywhere
  const results=[];
  await new Promise((res,rej)=>{
    const range=IDBKeyRange.bound(q,q+'\uffff');
    const req=db.transaction('webster','readonly').objectStore('webster').index('word_lower').openCursor(range);
    req.onsuccess=e=>{
      const c=e.target.result;
      if(c&&results.length<100){results.push(c.value);c.continue();}
      else res();
    };
    req.onerror=e=>rej(e.target.error);
  });
  return results;
}
async function idbPutWebsterEntries(rows){
  const db=await idbOpen();
  const tx=db.transaction('webster','readwrite');
  const st=tx.objectStore('webster');
  for(const r of rows)st.add({...r,word_lower:(r.word||'').toLowerCase()});
  return _txDone(tx);
}
async function idbClearWebster(){
  const db=await idbOpen();
  const tx=db.transaction('webster','readwrite');
  tx.objectStore('webster').clear();
  return _txDone(tx);
}

// ── Meta / download flags ─────────────────────────────────
async function idbGetMeta(key){try{const db=await idbOpen();const r=await _idbReq(db.transaction('meta','readonly').objectStore('meta').get(key));return r?.value;}catch{return undefined;}}
async function idbPutMeta(key,value){const db=await idbOpen();const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({key,value});return _txDone(tx);}
async function idbIsDownloaded(id){return(await idbGetMeta(`dl:${id}`))===true;}

// ── Bible version delete ──────────────────────────────────
async function idbDeleteVersionLocal(versionId){
  const db=await idbOpen();
  // Mark as not-downloaded first so a partial delete can't leave a stale true flag
  await idbPutMeta(`dl:${versionId}`,false);
  const tx=db.transaction('verses','readwrite');
  const st=tx.objectStore('verses');
  // Use PK range directly — faster than going through the by_chapter index
  const range=IDBKeyRange.bound(`${versionId}|`,`${versionId}|\uffff`);
  const req=st.openCursor(range);
  req.onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}};
  await _txDone(tx);
}

// ── Generic batch downloader ──────────────────────────────
async function _batchDownload({table,select,filter,order,putFn,dlKey,total:initTotal,onProgress,signal,resumeKey}){
  const BATCH=1000;let offset=0;let total=initTotal||0;
  // Pick up where an interrupted run stopped. putFn may return a "safe" offset —
  // the start of a group it has not finished assembling — so we never resume in
  // the middle of something only partially written to IndexedDB.
  if(resumeKey){const saved=await idbGetMeta(resumeKey).catch(()=>null);if(typeof saved==='number'&&saved>0)offset=saved;}
  onProgress&&onProgress(offset,total);
  while(true){
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const token=getToken();
    const hdrs={...sbHeaders(token),'Range-Unit':'items','Range':`${offset}-${offset+BATCH-1}`,'Prefer':'count=exact'};
    let url=`${SUPA_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
    if(filter)url+=`&${filter}`;
    if(order)url+=`&order=${order}`;
    const r=await fetch(url,{headers:hdrs,signal});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const cr=r.headers.get('Content-Range');
    if(cr){const m=cr.match(/\/(\d+)/);if(m)total=parseInt(m[1]);}
    const rows=await r.json();
    if(!Array.isArray(rows)||rows.length===0)break;
    const safe=await putFn(rows,offset);
    offset+=rows.length;
    if(resumeKey)await idbPutMeta(resumeKey,typeof safe==='number'?safe:offset);
    onProgress&&onProgress(offset,total);
    // Supabase caps responses at 1000 rows however large a Range we ask for, so a
    // short batch only means "finished" once we have reached the reported total.
    if(rows.length<BATCH&&(!total||offset>=total))break;
  }
  if(resumeKey)await idbPutMeta(resumeKey,0);
  await idbPutMeta(`dl:${dlKey}`,true);
}

async function downloadVersionLocally(versionId,onProgress,signal){
  await _batchDownload({table:'bible_verses',select:'book_num,chapter,verse,text',filter:`version_id=eq.${encodeURIComponent(versionId)}`,order:'book_num.asc,chapter.asc,verse.asc',putFn:rows=>idbPutVerses(versionId,rows),dlKey:versionId,total:31102,onProgress,signal});
}
// e-Sword .bblx book number → canonical 1-66
// OT: 10=Gen…390=Mal (÷10), NT: 470=Matt…730=Rev ((n-470)÷10+40)
function eswordBookToNum(b){return b<=390?b/10:(b-470)/10+40;}

async function importBblxFile({file,label,lang,userId,existingVersionId,onProgress}){
  // Lazily load sql.js WASM only when needed (~644 KB, loaded once)
  const initSqlJs=(await import('sql.js')).default;
  const SQL=await initSqlJs({locateFile:()=>`${BUNDLED_BASE}sql-wasm.wasm`});
  const buf=await file.arrayBuffer();
  const db=new SQL.Database(new Uint8Array(buf));
  // Try standard e-Sword Bible table; some files use a "verses" table
  let rows;
  try{rows=db.exec('SELECT Book,Chapter,Verse,Scripture FROM Bible ORDER BY Book,Chapter,Verse');}
  catch{rows=db.exec('SELECT Book,Chapter,Verse,Text FROM verses ORDER BY Book,Chapter,Verse');}
  db.close();
  if(!rows||!rows[0]||!rows[0].values.length)throw new Error('No verse data found in file');
  const values=rows[0].values;
  const stripTags=t=>String(t||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
  // Auto-detect book numbering: .bbli uses 1-66, .bblx uses multiples of 10 (10=Gen…730=Rev)
  // Use reduce instead of Math.max(...spread) to avoid stack overflow on large arrays
  const maxBook=values.reduce((m,[bk])=>bk>m?bk:m,0);
  const toBookNum=maxBook>66?eswordBookToNum:(bk=>bk);
  // Filter out apocryphal/unrecognised book numbers rather than throwing
  const mapped=values
    .map(([bk,ch,vs,txt])=>({book_num:toBookNum(bk),chapter:Number(ch),verse:Number(vs),text:stripTags(txt)}))
    .filter(r=>Number.isInteger(r.book_num)&&r.book_num>=1&&r.book_num<=66);
  if(!mapped.length)throw new Error('No valid Bible verses found in file');
  const versionId=existingVersionId||`user-${userId||'local'}-${Date.now()}`;
  // A replacement starts clean: writing over the old copy would keep any verse
  // the new file lacks.
  if(existingVersionId)await idbDeleteVersionLocal(versionId);
  const BATCH=2000;
  for(let i=0;i<mapped.length;i+=BATCH){
    await idbPutVerses(versionId,mapped.slice(i,i+BATCH));
    if(onProgress)onProgress(Math.min(i+BATCH,mapped.length),mapped.length);
  }
  await idbPutMeta(`dl:${versionId}`,true);
  // A new version registers; a replacement keeps its registration and updates the count.
  if(userId&&!existingVersionId){
    const token=getToken();
    await fetch(`${SUPA_URL}/rest/v1/bible_versions`,{
      method:'POST',
      headers:{...sbHeaders(token),'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({id:versionId,label,lang:lang||'EN',is_public:false,owner_id:userId,verse_count:mapped.length}),
    }).catch(()=>{});
  }else if(userId&&existingVersionId){
    const token=getToken();
    await fetch(`${SUPA_URL}/rest/v1/bible_versions?id=eq.${encodeURIComponent(versionId)}`,{
      method:'PATCH',
      headers:{...sbHeaders(token),'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({verse_count:mapped.length}),
    }).catch(()=>{});
  }
  return{id:versionId,label,lang:lang||'EN',isRef:false};
}
// Versions this reader imported, by the id importBblxFile gives them. Nothing
// outside that prefix -- a built-in, a public version, anyone else's -- is ever
// replaced or deleted by the two functions below.
function isOwnImport(versionId,userId){return typeof versionId==='string'&&versionId.startsWith(`user-${userId||'local'}-`);}
// Importing under a name and language already in the list is importing that
// version again. Matched on the name the reader gives, not the filename, since
// the name is what the list was showing twice.
function findOwnImport(list,label,lang,userId){
  const l=String(label||'').trim().toLowerCase(),g=String(lang||'EN').toUpperCase();
  return(list||[]).find(v=>isOwnImport(v.id,userId)&&String(v.label||'').trim().toLowerCase()===l&&String(v.lang||'EN').toUpperCase()===g)||null;
}
// Taking an imported version off the list used to leave its registration, and
// the loader -- which lists every version you own -- put it straight back. The
// registration goes first, so a failure leaves the text on this device intact.
async function deleteImportedVersion(versionId,user){
  const uid=user?.id;
  if(!isOwnImport(versionId,uid))return;
  if(uid&&!user.guest){
    const r=await fetch(`${SUPA_URL}/rest/v1/bible_versions?id=eq.${encodeURIComponent(versionId)}`,{method:'DELETE',headers:sbHeaders(getToken())});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    // Its highlights go with it; nothing could show them again.
    await sbFetch(`${HL_URL}?user_id=eq.${uid}&version_id=eq.${encodeURIComponent(versionId)}`,{method:'DELETE',headers:sbHeaders(getToken()),signal:sbSignal()},getToken()).catch(()=>{});
  }
  await idbDeleteVersionLocal(versionId).catch(()=>{});
}

// ── Data shipped inside the app ───────────────────────────────────────────
// public/bundled holds each dataset pre-shaped for the store it lands in, so a
// first launch is a bulk write with no network and no transformation. Built by
// scripts/export-bundled-data.mjs.
// BASE_URL matters: the Pages build is served from /Scriptorium/, so a leading
// slash would escape the app entirely.
const BUNDLED_BASE=(typeof import.meta!=='undefined'&&import.meta.env&&import.meta.env.BASE_URL)||'/';
async function _bundledJson(name){
  const r=await fetch(`${BUNDLED_BASE}bundled/${name}`);
  if(!r.ok)throw new Error(`bundled/${name} HTTP ${r.status}`);
  return r.json();
}
// ── Commentaries ──────────────────────────────────────────────────────────
// The Treasury of Scripture Knowledge ships in the bundle; a reader's own
// e-Sword commentaries are imported into the same store under their own id.
// Records hold src/commentary.js markup: `o` is the chapter's (or, at chapter
// 0, the book's) own note, `v` is [verse, markup, endVerse?, endChapter?].
const TSKE_ID='tske';
const TSKE={id:TSKE_ID,title:'Treasury of Scripture Knowledge',abbr:'TSKe',builtin:true};
// The licence asks for this notice with every copy.
const TSKE_NOTICE=['Copyright 2010-2014, Timothy S. Morton (www.BibleAnalyzer.com). All Rights Reserved.',
  'The original Treasury of Scripture Knowledge is in the public domain. This greatly enhanced and expanded edition is protected by a derivative copyright to ensure its free and open distribution. Thus permission is granted by the copyright holder to allow this text to be used under the following conditions:',
  'This text, including any additions or improvements that may be made to the text, must be distributed free of charge. If this text is in any way encrypted or placed in a proprietary format, it must also be provided separately, with any additions or improvements, in an open format, by the same party (by download is sufficient). The text can be bundled with items that are sold (CD-Rom, etc.) on the condition it is freely offered separately, with any additions or improvements, by the same party, in an open format (by download is sufficient). This copyright notice must be included with all distributions.',
  'There is no warranty expressed or implied in regard to this text.'];
async function idbPutCommentaryRecords(recs){
  const db=await idbOpen();
  const tx=db.transaction('commentary','readwrite');
  const st=tx.objectStore('commentary');
  for(const r of recs)st.put(r);
  return _txDone(tx);
}
async function idbGetCommentaryChapter(cid,b,c){
  const db=await idbOpen();
  return(await _idbReq(db.transaction('commentary','readonly').objectStore('commentary').get(`${cid}|${b}|${c}`)))||null;
}
async function idbDeleteCommentary(cid){
  const db=await idbOpen();
  const tx=db.transaction('commentary','readwrite');
  const req=tx.objectStore('commentary').index('by_cid').openKeyCursor(IDBKeyRange.only(cid));
  req.onsuccess=e=>{const c=e.target.result;if(!c)return;tx.objectStore('commentary').delete(c.primaryKey);c.continue();};
  return _txDone(tx);
}
async function idbListCommentaries(){
  const db=await idbOpen();
  return(await _idbReq(db.transaction('commentaries','readonly').objectStore('commentaries').getAll()))||[];
}
async function idbPutCommentaryMeta(meta){
  const db=await idbOpen();
  return _idbReq(db.transaction('commentaries','readwrite').objectStore('commentaries').put(meta));
}
async function idbDeleteCommentaryMeta(id){
  const db=await idbOpen();
  return _idbReq(db.transaction('commentaries','readwrite').objectStore('commentaries').delete(id));
}
// A reader's e-Sword .cmti, into the store the Treasury uses, through the same
// conversion scripts/export-tsk.mjs builds the Treasury with.
async function importCommentaryFile(file){
  const initSqlJs=(await import('sql.js')).default;
  const SQL=await initSqlJs({locateFile:()=>`${BUNDLED_BASE}sql-wasm.wasm`});
  let db;
  try{db=new SQL.Database(new Uint8Array(await file.arrayBuffer()));}
  catch{throw new Error(`${file.name} could not be opened. Is it an e-Sword commentary?`);}
  const id=`cmt-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  // Named entities the converter has no table for, decoded by the browser.
  const pad=document.createElement('textarea');
  const decodeNamed=e=>{pad.innerHTML=e;return pad.value;};
  const convert=h=>cmtiToMarkup(h,decodeNamed);
  try{
    const tables=new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values||[]).map(r=>String(r[0])));
    if(!['BookCommentary','ChapterCommentary','VerseCommentary'].some(t=>tables.has(t)))
      throw new Error(`${file.name} has no book, chapter or verse notes, so it isn't an e-Sword commentary Scriptorium can read.`);
    const q=sql=>{try{return db.exec(sql)[0]?.values||[];}catch{return[];}};
    const detail=col=>{const v=q(`SELECT ${col} FROM Details LIMIT 1`)[0]?.[0];return v?String(v).trim():'';};
    const title=detail('Title')||file.name.replace(/\.[^.]+$/,'').replace(/[-_]/g,' ').trim()||'Commentary';
    const abbr=detail('Abbreviation');
    const info=convert(detail('Information')||detail('Description')||detail('Comments'));
    const recs=new Map();
    const rec=(b,c)=>{const pk=`${id}|${b}|${c}`;if(!recs.has(pk))recs.set(pk,{pk,cid:id,b,c,o:'',v:[]});return recs.get(pk);};
    const inBible=(b,c)=>b>=1&&b<=66&&c>=0&&c<=(BIBLE[b-1]?.v?.length||0);
    if(tables.has('BookCommentary'))for(const[b,t]of q('SELECT Book, Comments FROM BookCommentary'))if(inBible(b,0)){const m=convert(t);if(m)rec(b,0).o=m;}
    if(tables.has('ChapterCommentary'))for(const[b,c,t]of q('SELECT Book, Chapter, Comments FROM ChapterCommentary'))if(inBible(b,c)&&c>0){const m=convert(t);if(m)rec(b,c).o=m;}
    if(tables.has('VerseCommentary'))for(const[b,c1,c2,v1,v2,t]of q('SELECT Book, ChapterBegin, ChapterEnd, VerseBegin, VerseEnd, Comments FROM VerseCommentary ORDER BY Book, ChapterBegin, VerseBegin')){
      if(!inBible(b,c1)||c1<1)continue;
      const m=dropSelfLine(convert(t),b,c1,v1);
      if(!m)continue;
      const e=[v1,m];
      if(c2>c1)e.push(v2,c2);else if(v2>v1)e.push(v2);
      rec(b,c1).v.push(e);
    }
    const all=[...recs.values()];
    if(!all.length)throw new Error(`${file.name} opened, but none of its notes are on a book of the Bible.`);
    for(let i=0;i<all.length;i+=100)await idbPutCommentaryRecords(all.slice(i,i+100));
    const meta={id,title,abbr,info,importedAt:Date.now(),chapters:all.length};
    await idbPutCommentaryMeta(meta);
    return meta;
  }catch(e){
    await idbDeleteCommentary(id).catch(()=>{});
    throw e;
  }finally{
    try{db.close();}catch{}
  }
}

const BUNDLED_DATASETS={
  kjv:{clear:()=>idbDeleteVersionLocal('kjv'),flags:['dl:kjv'],
    load:async f=>{const rows=await _bundledJson(f);for(let i=0;i<rows.length;i+=2000)await idbPutVerses('kjv',rows.slice(i,i+2000));return rows.length;}},
  strongs_lex:{clear:()=>idbClearStore('strongs_lex'),flags:['dl:strongs'],strongs:true,
    load:async f=>{const rows=await _bundledJson(f);for(let i=0;i<rows.length;i+=2000)await idbPutStrongsEntries(rows.slice(i,i+2000));return rows.length;}},
  strongs_map:{clear:()=>idbClearStore('strongs_map'),flags:['dl:strongsmap'],strongs:true,
    load:async f=>{const recs=await _bundledJson(f);for(let i=0;i<recs.length;i+=200)await idbPutStrongsMapChapters(recs.slice(i,i+200));return recs.length;}},
  strongs_occ:{clear:()=>idbClearStore('strongs_occ'),flags:['dl:strongsocc'],strongs:true,
    load:async f=>{const recs=await _bundledJson(f);for(let i=0;i<recs.length;i+=500)await idbPutStrongsOcc(recs.slice(i,i+500));return recs.length;}},
  webster:{clear:()=>idbClearStore('webster'),flags:['dl:webster'],
    load:async f=>{const rows=await _bundledJson(f);for(let i=0;i<rows.length;i+=2000)await idbPutWebsterEntries(rows.slice(i,i+2000));return rows.length;}},
  // The Treasury's description rides along for its information page.
  tske:{clear:()=>idbDeleteCommentary(TSKE_ID),flags:[],background:true,
    load:async f=>{const d=await _bundledJson(f);const recs=d.records||[];for(let i=0;i<recs.length;i+=100)await idbPutCommentaryRecords(recs.slice(i,i+100));await idbPutMeta(`commentary:${TSKE_ID}`,{title:d.title,info:d.info}).catch(()=>{});return recs.length;}},
};
// Installs any bundled dataset the device doesn't already hold at the shipped
// version. Returns true if it wrote anything.
async function installBundledDatasets(onProgress,{background=false}={}){
  bootMark(background?'bg-install-check':'install-check');
  let man;
  try{man=await _bundledJson('manifest.json');}
  catch(e){await idbPutMeta('bundled:status',{ok:false,stage:'manifest',error:String(e&&e.message||e),at:Date.now()}).catch(()=>{});return false;}
  const ds=(man&&man.datasets)||null;
  if(!ds){await idbPutMeta('bundled:status',{ok:false,stage:'manifest',error:'no datasets in manifest',at:Date.now()}).catch(()=>{});return false;}
  const jobs=[];
  for(const name of Object.keys(BUNDLED_DATASETS)){
    // Two passes: what the app needs to open, behind the install screen, and
    // what it does not, once it is open.
    if(!!BUNDLED_DATASETS[name].background!==background)continue;
    const d=ds[name];
    if(!d||!Array.isArray(d.files))continue;
    const have=await idbGetMeta(`bundled:${name}`).catch(()=>null);
    if(have===d.version)continue;
    jobs.push([name,d]);
  }
  if(!jobs.length){bootMark(background?'bg-install-none':'install-none');await idbPutMeta('bundled:status',{ok:true,stage:'already-installed',installed:[],at:Date.now()}).catch(()=>{});return false;}
  bootMark(background?'bg-install-jobs':'install-jobs',jobs.map(([n,d])=>`${n}@${d.version}`).join(','));
  const total=jobs.reduce((s,[,d])=>s+(d.rows||1),0);
  let done=0,touchedStrongs=false;
  const installed=[];
  onProgress&&onProgress(0,total);
  for(const [name,d] of jobs){
    const inst=BUNDLED_DATASETS[name];
    try{
    // Webster uses an auto-incrementing key, so a reinstall must clear first or
    // it silently doubles every entry.
    await inst.clear().catch(()=>{});
    for(const f of d.files){done+=await inst.load(f);onProgress&&onProgress(done,total);}
    for(const k of inst.flags)await idbPutMeta(k,true);
    await idbPutMeta(`bundled:${name}`,d.version);
    installed.push(name);
    if(inst.strongs)touchedStrongs=true;
    }catch(e){
      bootMark('install-failed',`${name}: ${e&&e.message||e}`);
      await idbPutMeta('bundled:status',{ok:false,stage:name,error:String(e&&e.message||e),installed,at:Date.now()}).catch(()=>{});
      throw e;
    }
  }
  bootMark(background?'bg-install-done':'install-done',installed.join(','));
  await idbPutMeta('bundled:status',{ok:true,stage:'installed',installed,at:Date.now()}).catch(()=>{});
  // Stamp the payload version, or the freshness check would clear what we just wrote.
  if(touchedStrongs)await idbPutMeta('dlver:strongs',STRONGS_DL_VERSION);
  return true;
}
const STRONGS_LEX_ROWS=14197;
const STRONGS_MAP_ROWS=785856;
// The occurrence index is built locally from the mapping already on disk rather
// than downloaded again. Building it in one pass would hold ~360k refs in memory
// at once, so it is built in buckets: each pass keeps only the Strong's numbers
// that hash to it, trading a few extra local reads for a small memory ceiling.
const STRONGS_OCC_ROWS=574013;
// Bump whenever the offline Strong's payload changes shape. A device holding an
// older download is cleared on next launch so it re-fetches rather than silently
// serving data the current code no longer understands.
const STRONGS_DL_VERSION=2;
async function ensureStrongsDownloadFresh(){
  const cur=await idbGetMeta('dlver:strongs').catch(()=>null);
  if(cur===STRONGS_DL_VERSION)return false;
  const had=(await idbGetMeta('dl:strongs').catch(()=>null))===true;
  if(had){
    await idbClearStrongs().catch(()=>{});
    for(const k of ['dl:strongs','dl:strongsmap','dl:strongsocc','res:strongslex','res:strongsmap','res:strongsocc'])await idbPutMeta(k,k.startsWith('res:')?0:false).catch(()=>{});
  }
  await idbPutMeta('dlver:strongs',STRONGS_DL_VERSION).catch(()=>{});
  return had;
}
// Occurrence rows are authoritative for which verses contain a number and how
// many times. strongs_mapping only supplies the English KJV word, and 126,063
// of the 448,733 occurrence refs have no mapping row at all — for those the
// server falls back to the STEPBible gloss, so we must too.
// This pass builds that KJV-word lookup from the mapping already on disk. It runs
// in hash buckets because a single pass would hold ~360k refs in memory at once.
const STRONGS_OCC_BUCKETS=8;
const STRONGS_KJVW_UNITS=80000; // nominal progress weight for this build phase
function _snBucket(sn){let h=0;for(let i=0;i<sn.length;i++)h=(h*31+sn.charCodeAt(i))|0;return((h%STRONGS_OCC_BUCKETS)+STRONGS_OCC_BUCKETS)%STRONGS_OCC_BUCKETS;}
async function idbPutStrongsKjvw(records){
  const db=await idbOpen();
  const tx=db.transaction('strongs_kjvw','readwrite');
  const st=tx.objectStore('strongs_kjvw');
  for(const rec of records)st.put(rec);
  return _txDone(tx);
}
async function idbClearStore(name){
  const db=await idbOpen();
  const tx=db.transaction(name,'readwrite');
  tx.objectStore(name).clear();
  return _txDone(tx);
}
async function buildKjvWordIndex(onProgress,signal){
  const db=await idbOpen();
  for(let b=0;b<STRONGS_OCC_BUCKETS;b++){
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const acc=new Map();
    await new Promise((res,rej)=>{
      const req=db.transaction('strongs_map','readonly').objectStore('strongs_map').openCursor();
      req.onsuccess=e=>{
        const c=e.target.result;if(!c)return res();
        const parts=String(c.value.pk).split('|');
        const book=+parts[0],chap=+parts[1];
        for(const row of c.value.rows){
          const verse=row[0],word_text=row[2],sn=row[3];
          if(_snBucket(sn)!==b)continue;
          let w=acc.get(sn);if(!w){w={};acc.set(sn,w);}
          // Ascending word_pos, so the last write wins — matching the server's
          // DISTINCT ON ... ORDER BY word_pos DESC.
          w[book+'|'+chap+'|'+verse]=word_text;
        }
        c.continue();
      };
      req.onerror=e=>rej(e.target.error);
    });
    const recs=[];
    for(const [sn,w] of acc)recs.push({sn,w});
    if(recs.length)await idbPutStrongsKjvw(recs);
    onProgress&&onProgress(b+1,STRONGS_OCC_BUCKETS);
  }
}
async function downloadStrongsLocally(onProgress,signal){
  const db2=await idbOpen();
  const TOTAL=STRONGS_LEX_ROWS+STRONGS_MAP_ROWS+STRONGS_KJVW_UNITS+STRONGS_OCC_ROWS;
  // Read progress before touching any flags. An interrupted run leaves completed
  // phases flagged and a saved offset inside the phase it was in, so resuming must
  // not wipe the store those offsets point into.
  const lexDone=(await idbGetMeta('dl:strongs').catch(()=>null))===true;
  const mapDone=(await idbGetMeta('dl:strongsmap').catch(()=>null))===true;
  let partial=lexDone||mapDone;
  for(const k of ['res:strongslex','res:strongsmap','res:strongsocc']){
    const v=await idbGetMeta(k).catch(()=>null);
    if(typeof v==='number'&&v>0)partial=true;
  }
  await idbPutMeta('dl:strongsocc',false);
  if(!partial){
    await idbPutMeta('dl:strongs',false);
    await idbPutMeta('dl:strongsmap',false);
    await idbClearStrongs();
  }
  // Lexicon first. _batchDownload flags dl:strongs as soon as it lands, so
  // definitions and search keep working offline even if the much longer
  // mapping pass below is cancelled part way through.
  if(!lexDone)await _batchDownload({table:'strongs_lexicon',select:'strongs_number,original_word,transliteration,pronunciation,language,short_def,full_def,kjv_usage,occurrence_count',order:'strongs_number.asc',putFn:idbPutStrongsEntries,dlKey:'strongs',resumeKey:'res:strongslex',total:STRONGS_LEX_ROWS,onProgress:d=>onProgress&&onProgress(d,TOTAL),signal});
  // Mapping streams in chapter order and is flushed a chapter at a time, so we
  // never hold more than one chapter of rows in memory.
  let curKey=null,curRows=[],groupStart=0;
  const putMap=async(rows,offsetBefore)=>{
    let idx=offsetBefore;const done=[];
    for(const r of rows){
      const k=`${r.book_num}|${r.chapter}`;
      if(k!==curKey){if(curKey!==null)done.push({pk:curKey,rows:curRows});curKey=k;curRows=[];groupStart=idx;}
      curRows.push([r.verse,r.word_pos,r.word_text,r.strongs_num]);idx++;
    }
    // Written every batch rather than every 64 chapters so the resume offset below
    // is always backed by data actually on disk.
    if(done.length)await idbPutStrongsMapChapters(done);
    return groupStart;
  };
  if(!mapDone){
    await _batchDownload({table:'strongs_mapping',select:'book_num,chapter,verse,word_pos,word_text,strongs_num',order:'book_num.asc,chapter.asc,verse.asc,word_pos.asc',putFn:putMap,dlKey:'strongsmap',resumeKey:'res:strongsmap',total:STRONGS_MAP_ROWS,onProgress:d=>onProgress&&onProgress(STRONGS_LEX_ROWS+d,TOTAL),signal});
    // _batchDownload marks the key done, but the trailing chapter is still buffered.
    await idbPutMeta('dl:strongsmap',false);
    if(curKey!==null)await idbPutStrongsMapChapters([{pk:curKey,rows:curRows}]);
    await idbPutMeta('dl:strongsmap',true);
  }
  // KJV word lookup, derived from the mapping just stored.
  const BASE=STRONGS_LEX_ROWS+STRONGS_MAP_ROWS;
  await buildKjvWordIndex((done,steps)=>onProgress&&onProgress(BASE+Math.round(done/steps*STRONGS_KJVW_UNITS),TOTAL),signal);
  // Occurrences themselves. Ordered by Strong's number so each group can be
  // completed and flushed as it streams, keeping one group in memory at a time.
  const totals=new Map();
  await new Promise((res,rej)=>{
    const req=db2.transaction('strongs_lex','readonly').objectStore('strongs_lex').openCursor();
    req.onsuccess=e=>{const c=e.target.result;if(!c)return res();
      const v=c.value;if(v&&v.occurrence_count!=null)totals.set(v.strongs_number,v.occurrence_count);
      c.continue();};
    req.onerror=e=>rej(e.target.error);
  });
  const OBASE=BASE+STRONGS_KJVW_UNITS;
  let oSn=null,oVerses=null,oGroupStart=0;
  const buildOccRec=async(sn,verses)=>{
    const kj=await _idbReq((await idbOpen()).transaction('strongs_kjvw','readonly').objectStore('strongs_kjvw').get(sn));
    const w=(kj&&kj.w)||{};
    const refs=[];
    for(const [k,v] of verses){
      const kw=w[k];
      refs.push([v[0],v[1],v[2],(kw!==undefined&&kw!==null)?kw:v[4],v[3]]);
    }
    refs.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
    return{sn,total:totals.has(sn)?totals.get(sn):null,refs};
  };
  const putOcc=async(rows,offsetBefore)=>{
    let idx=offsetBefore;const done=[];
    for(const r of rows){
      if(r.strongs_num!==oSn){if(oSn!==null)done.push([oSn,oVerses]);oSn=r.strongs_num;oVerses=new Map();oGroupStart=idx;}
      const k=r.book_num+'|'+r.chapter+'|'+r.verse;
      const cur=oVerses.get(k);
      // count occurrences per verse; keep the greatest gloss, mirroring MAX(gloss)
      if(cur){cur[3]++;if(r.gloss&&(!cur[4]||r.gloss>cur[4]))cur[4]=r.gloss;}
      else oVerses.set(k,[r.book_num,r.chapter,r.verse,1,r.gloss||null]);
      idx++;
    }
    if(done.length){const recs=[];for(const [sn,vs] of done)recs.push(await buildOccRec(sn,vs));await idbPutStrongsOcc(recs);}
    return oGroupStart;
  };
  await _batchDownload({table:'strongs_word_occurrences',select:'strongs_num,book_num,chapter,verse,gloss',order:'strongs_num.asc,book_num.asc,chapter.asc,verse.asc',putFn:putOcc,dlKey:'strongsocc',resumeKey:'res:strongsocc',total:STRONGS_OCC_ROWS,onProgress:d=>onProgress&&onProgress(OBASE+d,TOTAL),signal});
  await idbPutMeta('dl:strongsocc',false);
  if(oSn!==null)await idbPutStrongsOcc([await buildOccRec(oSn,oVerses)]);
  // Scratch lookup is only needed while building.
  await idbClearStore('strongs_kjvw').catch(()=>{});
  await idbPutMeta('dlver:strongs',STRONGS_DL_VERSION);
  await idbPutMeta('dl:strongsocc',true);
}
async function downloadWebsterLocally(onProgress,signal){
  await idbPutMeta('dl:webster',false);
  await idbClearWebster();
  await _batchDownload({table:'webster_1828',select:'word,pos,definitions',order:'word.asc',putFn:idbPutWebsterEntries,dlKey:'webster',total:107793,onProgress,signal});
}

// ── Other Resources (user-imported books) ─────────────────
async function idbGetAllResources(){
  const db=await idbOpen();
  const rows=await _idbReq(db.transaction('resources','readonly').objectStore('resources').getAll());
  return(rows||[]).sort((a,b)=>b.importedAt-a.importedAt);
}
async function idbGetResource(id){
  const db=await idbOpen();
  return _idbReq(db.transaction('resources','readonly').objectStore('resources').get(id));
}
async function idbPutResource(res){
  const db=await idbOpen();
  return _idbReq(db.transaction('resources','readwrite').objectStore('resources').put(res));
}
async function idbPutResourceBlob(id,data){
  const db=await idbOpen();
  return _idbReq(db.transaction('resource_blobs','readwrite').objectStore('resource_blobs').put({id,data}));
}
async function idbGetResourceBlob(id){
  const db=await idbOpen();
  return _idbReq(db.transaction('resource_blobs','readonly').objectStore('resource_blobs').get(id));
}
async function idbDeleteResourceBlob(id){
  const db=await idbOpen();
  return _idbReq(db.transaction('resource_blobs','readwrite').objectStore('resource_blobs').delete(id));
}
async function idbDeleteResource(id){
  const db=await idbOpen();
  try{await _idbReq(db.transaction('resource_blobs','readwrite').objectStore('resource_blobs').delete(id));}catch{}
  return _idbReq(db.transaction('resources','readwrite').objectStore('resources').delete(id));
}
// Load a resource and populate its chapters from blob store if needed
async function idbGetResourceWithChapters(id){
  const res=await idbGetResource(id);
  if(!res)return null;
  if(res.chapters)return res;
  if(res.kind==='sqlite'){
    const blob=await idbGetResourceBlob(id).catch(()=>null);
    if(blob?.data){
      try{const chapters=JSON.parse(new TextDecoder().decode(blob.data));return{...res,chapters};}catch{}
    }
  }
  return res;
}

function parseResourceFile(text,filename){
  const ext=(filename||'').split('.').pop().toLowerCase();
  const baseName=filename.replace(/\.[^/.]+$/,'').replace(/[-_]/g,' ').trim();
  let title=baseName;
  let chapters=[];

  if(ext==='md'){
    const lines=text.split('\n');
    let titleSet=false;let cur=null;let curLines=[];
    for(const line of lines){
      if(line.startsWith('# ')){
        const heading=line.slice(2).trim();
        if(!titleSet&&cur===null&&!curLines.some(l=>l.trim())){
          title=heading;titleSet=true;
        } else {
          if(cur!==null||curLines.some(l=>l.trim()))
            chapters.push({title:cur||'Introduction',body:curLines.join('\n').trim()});
          cur=heading;curLines=[];
        }
      } else {
        curLines.push(line);
      }
    }
    if(cur!==null)chapters.push({title:cur,body:curLines.join('\n').trim()});
    if(!chapters.length)chapters=[{title,body:text.trim()}];
  } else {
    // Plain text: detect "Chapter X" lines as section breaks
    const CHAPTER_RE=/^\s*(?:CHAPTER|Chapter)\s+(?:\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)\b.*$/;
    const lines=text.split('\n');
    let cur=null;let curLines=[];
    for(const line of lines){
      if(CHAPTER_RE.test(line.trim())){
        if(cur!==null)chapters.push({title:cur,body:curLines.join('\n').trim()});
        else if(curLines.some(l=>l.trim()))chapters.push({title:'Introduction',body:curLines.join('\n').trim()});
        cur=line.trim();curLines=[];
      } else {
        curLines.push(line);
      }
    }
    // Flush final chapter
    if(cur!==null)chapters.push({title:cur,body:curLines.join('\n').trim()});
    else if(curLines.some(l=>l.trim()))chapters=[{title,body:text.trim()}];
    if(!chapters.length)chapters=[{title,body:text.trim()}];
  }

  return{
    id:`res-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    title,ext,chapters,
    importedAt:Date.now(),
    totalChars:text.length,
  };
}

async function importResourceFile(file){
  return importUserResource(file,'other');
}

// ── Unified multi-format resource importer ────────────────
// iOS greys out every file the picker's `accept` list does not name, and it
// only recognises the common extensions -- .txt, .md, .pdf, the images. The
// e-Sword and MySword ones (.cmti, .lexi, .dcti, .devi, .refi, .dzip) it
// cannot place, so a list mixing the two let the common files through and
// greyed out the modules these pickers exist for. The Bible picker names only
// module extensions and is unaffected, so it keeps its list. On iOS these
// pickers now show every file, and the extension is checked here instead.
const RES_ACCEPT={
  lexicon:'.lexi,.txt,.md,.pdf,.dzip',
  dict:'.dcti,.txt,.md,.pdf,.dzip',
  other:'.txt,.md,.pdf,.jpg,.jpeg,.png,.webp,.cmti,.devi,.refi,.dzip',
};
const pickerAccept=kind=>Capacitor.getPlatform()==='ios'?undefined:RES_ACCEPT[kind];
function checkPicked(file,kind){
  const ok=RES_ACCEPT[kind].split(','),ext='.'+String(file.name||'').split('.').pop().toLowerCase();
  if(!ok.includes(ext))throw new Error(`${file.name} can't be imported here. Choose a ${ok.filter(x=>x!=='.jpeg').join(', ')} file.`);
}
async function importUserResource(file,category){
  const name=file.name||'untitled';
  const ext=name.split('.').pop().toLowerCase();
  const baseName=name.replace(/\.[^/.]+$/,'').replace(/[-_]/g,' ').trim()||'Untitled';
  const id=`res-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

  if(ext==='txt'||ext==='md'){
    const text=await file.text();
    if(!text.trim())throw new Error('File is empty.');
    const parsed=parseResourceFile(text,name);
    const res={...parsed,id,category};
    await idbPutResource(res);
    return res;
  }

  if(ext==='jpg'||ext==='jpeg'||ext==='png'||ext==='webp'||ext==='gif'){
    const buf=await file.arrayBuffer();
    const mimeMap={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};
    const mime=mimeMap[ext]||'image/jpeg';
    const meta={id,title:baseName,ext,category,importedAt:Date.now(),kind:'image',mime,size:buf.byteLength};
    await idbPutResourceBlob(id,buf);
    await idbPutResource(meta);
    return meta;
  }

  if(ext==='pdf'){
    const buf=await file.arrayBuffer();
    const meta={id,title:baseName,ext,category,importedAt:Date.now(),kind:'pdf',mime:'application/pdf',size:buf.byteLength};
    await idbPutResourceBlob(id,buf);
    await idbPutResource(meta);
    return meta;
  }

  if(ext==='dzip'){
    return _importDzipResource(file,id,baseName,category);
  }

  if(['lexi','dcti','cmti','devi','refi'].includes(ext)){
    return _importSqliteResource(file,id,baseName,ext,category);
  }

  throw new Error(`Unsupported file type: .${ext}`);
}

// Module HTML to the resource reader's text: paragraphs apart by a blank line,
// entities decoded (the book introductions carry Greek and Hebrew as entities).
function htmlToParas(html){
  const s=String(html||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|li|div|h\d)>/gi,'\n\n');
  const text=new DOMParser().parseFromString(s,'text/html').body.textContent||'';
  return text.replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function _importSqliteResource(file,id,baseName,ext,category){
  const initSqlJs=(await import('sql.js')).default;
  const SQL=await initSqlJs({locateFile:()=>`${BUNDLED_BASE}sql-wasm.wasm`});
  const buf=await file.arrayBuffer();
  const db=new SQL.Database(new Uint8Array(buf));
  let chapters=[],title=baseName;
  const tables=new Set((db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values||[]).map(r=>String(r[0])));
  const detailsTitle=()=>{try{const t=db.exec('SELECT Title FROM Details LIMIT 1')[0]?.values[0]?.[0];return t?String(t).trim():'';}catch{return '';}};
  try{
    if(ext==='lexi'){
      let rows;
      try{rows=db.exec('SELECT Topic, Definition FROM Lexicon ORDER BY Topic');}
      catch{rows=db.exec('SELECT Topic, Details FROM Lexicon ORDER BY Topic');}
      if(rows[0])chapters=rows[0].values.map(([t,d])=>({title:String(t||''),body:String(d||'')}));
    } else if(ext==='dcti'){
      let rows;
      try{rows=db.exec('SELECT Topic, Definition FROM Dictionary ORDER BY Topic');}
      catch{rows=db.exec('SELECT Topic, Details FROM Dictionary ORDER BY Topic');}
      if(rows[0])chapters=rows[0].values.map(([t,d])=>({title:String(t||''),body:String(d||'')}));
    } else if(ext==='cmti'&&tables.has('VerseCommentary')){
      // e-Sword's own layout: notes on a whole book, on a chapter, and on a verse
      // or range, each as HTML. A book's is a page of its own ahead of chapter 1;
      // a chapter's opens that chapter's page.
      title=detailsTitle()||baseName;
      const q=sql=>db.exec(sql)[0]?.values||[];
      const bookName_=bn=>BIBLE[bn-1]?.name||`Book ${bn}`;
      const pages=new Map(),page=(bn,ch)=>{const k=`${bn}|${ch}`;if(!pages.has(k))pages.set(k,{bn,ch,title:ch?`${bookName_(bn)} ${ch}`:`${bookName_(bn)} \u2014 Introduction`,parts:[]});return pages.get(k);};
      for(const[bn,c]of q('SELECT Book, Comments FROM BookCommentary')){const t=htmlToParas(c);if(t)page(bn,0).parts.push(t);}
      for(const[bn,ch,c]of q('SELECT Book, Chapter, Comments FROM ChapterCommentary ORDER BY Book,Chapter')){const t=htmlToParas(c);if(t)page(bn,ch).parts.push(t);}
      for(const[bn,c1,v1,c2,v2,c]of q('SELECT Book, ChapterBegin, VerseBegin, ChapterEnd, VerseEnd, Comments FROM VerseCommentary ORDER BY Book,ChapterBegin,VerseBegin')){
        const t=htmlToParas(c);if(!t)continue;
        const span=c2>c1?`${v1}\u2013${c2}:${v2}`:v2>v1?`${v1}\u2013${v2}`:`${v1}`;
        page(bn,c1).parts.push(`[${span}] ${t}`);
      }
      chapters=[...pages.values()].sort((a,b)=>a.bn-b.bn||a.ch-b.ch).map(pg=>({title:pg.title,body:pg.parts.join('\n\n')}));
    } else if(ext==='cmti'){
      // The older single-table layout.
      let rows;
      try{rows=db.exec('SELECT BookNumber, ChapterNumber, VerseNumber, CommentaryText FROM Commentary ORDER BY BookNumber,ChapterNumber,VerseNumber');}
      catch{rows=db.exec('SELECT Book, Chapter, Verse, Text FROM Commentary ORDER BY Book,Chapter,Verse');}
      if(rows[0]){
        const grouped={};
        for(const [bn,ch,vs,txt] of rows[0].values){
          const bname=(typeof BIBLE!=='undefined'&&BIBLE[bn-1]?.name)||`Book ${bn}`;
          const key=`${bn}|${ch}`;
          if(!grouped[key])grouped[key]={title:`${bname} ${ch}`,body:''};
          grouped[key].body+=`[${vs}] ${String(txt||'').replace(/<[^>]+>/g,'').trim()}\n\n`;
        }
        chapters=Object.values(grouped);
      }
    } else if(ext==='devi'){
      let rows;
      try{rows=db.exec('SELECT Day, Title, Text FROM Devotional ORDER BY Day');}
      catch{rows=db.exec('SELECT Day, Title, Description FROM Devotional ORDER BY Day');}
      if(rows[0])chapters=rows[0].values.map(([day,t,txt])=>({title:t||`Day ${day}`,body:String(txt||'').replace(/<[^>]+>/g,'').trim()}));
    } else if(ext==='refi'){
      // Try Reference book format first (Chapter title + HTML Content)
      let refRows=null;
      try{refRows=db.exec('SELECT Chapter, Content FROM Reference ORDER BY rowid');}catch{}
      if(refRows?.[0]?.values?.length){
        // Pull proper title from Details table
        title=detailsTitle().split('(')[0].trim()||baseName;
        const stripHtml=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim();
        chapters=refRows[0].values.map(([ch,content])=>({title:String(ch||''),body:stripHtml(content)}));
      } else {
        // Fall back to verse cross-reference format
        let rows;
        try{rows=db.exec('SELECT Book, Chapter, Verse, CrossReference FROM CrossReference ORDER BY Book,Chapter,Verse');}
        catch{rows=db.exec('SELECT Book, Chapter, Verse, References FROM CrossReference ORDER BY Book,Chapter,Verse');}
        if(rows?.[0]){
          const grouped={};
          for(const [bn,ch,vs,refs] of rows[0].values){
            const bname=(typeof BIBLE!=='undefined'&&BIBLE[bn-1]?.name)||`Book ${bn}`;
            const key=`${bn}|${ch}`;
            if(!grouped[key])grouped[key]={title:`${bname} ${ch}`,body:''};
            grouped[key].body+=`[${vs}] ${String(refs||'').trim()}\n`;
          }
          chapters=Object.values(grouped);
        }
      }
    }
  } finally {
    try{db.close();}catch{}
  }
  if(!chapters.length)throw new Error('No data found in this file. Make sure it is a valid MySword database.');
  const chapterJson=new TextEncoder().encode(JSON.stringify(chapters)).buffer;
  await idbPutResourceBlob(id,chapterJson);
  const meta={id,title,ext,category,importedAt:Date.now(),kind:'sqlite',entryCount:chapters.length};
  await idbPutResource(meta);
  return meta;
}

async function _importDzipResource(file,id,baseName,category){
  const JSZip=(await import('jszip')).default;
  const buf=await file.arrayBuffer();
  let zip;
  try{zip=await JSZip.loadAsync(buf);}
  catch(e){throw new Error('Could not open archive: '+e.message);}
  const entries=Object.entries(zip.files).filter(([,f])=>!f.dir);
  if(!entries.length)throw new Error('Archive is empty.');
  const knownExts=['lexi','dcti','cmti','devi','refi'];
  const found=entries.find(([n])=>knownExts.includes(n.split('.').pop().toLowerCase()));
  if(!found)throw new Error('No recognized database file found inside archive.');
  const[innerName,innerZipFile]=found;
  const innerExt=innerName.split('.').pop().toLowerCase();
  const innerData=await innerZipFile.async('uint8array');
  const innerFile=new File([innerData.buffer],innerName,{type:'application/octet-stream'});
  return _importSqliteResource(innerFile,id,baseName,innerExt,category);
}


// ══════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════
const BIBLE = [
  {n:1,name:'Genesis',nameES:'Génesis',v:[31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26]},
  {n:2,name:'Exodus',nameES:'Éxodo',v:[22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,16,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38]},
  {n:3,name:'Leviticus',nameES:'Levítico',v:[17,16,17,35,19,30,38,36,24,20,47,8,59,57,33,34,16,30,37,27,24,33,44,23,55,46,34]},
  {n:4,name:'Numbers',nameES:'Números',v:[54,34,51,49,31,27,89,26,23,36,35,16,33,45,41,50,13,32,22,29,35,41,30,25,18,65,23,31,40,16,54,42,56,29,34,13]},
  {n:5,name:'Deuteronomy',nameES:'Deuteronomio',v:[46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,29,20,30,52,29,12]},
  {n:6,name:'Joshua',nameES:'Josué',v:[18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33]},
  {n:7,name:'Judges',nameES:'Jueces',v:[36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25]},
  {n:8,name:'Ruth',nameES:'Rut',v:[22,23,18,22]},
  {n:9,name:'1 Samuel',nameES:'1 Samuel',v:[28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13]},
  {n:10,name:'2 Samuel',nameES:'2 Samuel',v:[27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25]},
  {n:11,name:'1 Kings',nameES:'1 Reyes',v:[53,46,28,34,18,38,51,66,28,29,43,33,34,31,34,34,24,46,21,43,29,53]},
  {n:12,name:'2 Kings',nameES:'2 Reyes',v:[18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,41,37,37,21,26,20,37,20,30]},
  {n:13,name:'1 Chronicles',nameES:'1 Crónicas',v:[54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30]},
  {n:14,name:'2 Chronicles',nameES:'2 Crónicas',v:[17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23]},
  {n:15,name:'Ezra',nameES:'Esdras',v:[11,70,13,24,17,22,28,36,15,44]},
  {n:16,name:'Nehemiah',nameES:'Nehemías',v:[11,20,32,23,19,19,73,18,38,39,36,47,31]},
  {n:17,name:'Esther',nameES:'Ester',v:[22,23,15,17,14,14,10,17,32,3]},
  {n:18,name:'Job',nameES:'Job',v:[22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,28,25,31,40,22,33,37,16,33,24,41,30,24,34,17]},
  {n:19,name:'Psalms',nameES:'Salmos',v:[6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,6,8,8,3,18,3,3,21,26,9,8,24,13,10,7,12,15,21,10,20,14,9,6]},
  {n:20,name:'Proverbs',nameES:'Proverbios',v:[33,22,35,27,23,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,29,35,34,28,28,27,28,27,33,31]},
  {n:21,name:'Ecclesiastes',nameES:'Eclesiastés',v:[18,26,22,16,20,12,29,17,18,20,10,14]},
  {n:22,name:'Song of Solomon',nameES:'Cantares',v:[17,17,11,16,16,13,13,14]},
  {n:23,name:'Isaiah',nameES:'Isaías',v:[31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24]},
  {n:24,name:'Jeremiah',nameES:'Jeremías',v:[19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34]},
  {n:25,name:'Lamentations',nameES:'Lamentaciones',v:[22,22,66,22,22]},
  {n:26,name:'Ezekiel',nameES:'Ezequiel',v:[28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,14,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,15,38,28,23,29,49,26,20,27,31,25,24,23,35]},
  {n:27,name:'Daniel',nameES:'Daniel',v:[21,49,30,37,31,28,28,27,27,21,45,13]},
  {n:28,name:'Hosea',nameES:'Oseas',v:[11,23,5,19,15,11,16,14,17,15,12,14,16,9]},
  {n:29,name:'Joel',nameES:'Joel',v:[20,32,21]},
  {n:30,name:'Amos',nameES:'Amós',v:[15,16,15,13,27,14,17,14,15]},
  {n:31,name:'Obadiah',nameES:'Abdías',v:[21]},
  {n:32,name:'Jonah',nameES:'Jonás',v:[17,10,10,11]},
  {n:33,name:'Micah',nameES:'Miqueas',v:[16,13,12,13,15,16,20]},
  {n:34,name:'Nahum',nameES:'Nahúm',v:[15,13,19]},
  {n:35,name:'Habakkuk',nameES:'Habacuc',v:[17,20,19]},
  {n:36,name:'Zephaniah',nameES:'Sofonías',v:[18,15,20]},
  {n:37,name:'Haggai',nameES:'Hageo',v:[15,23]},
  {n:38,name:'Zechariah',nameES:'Zacarías',v:[21,13,10,14,11,15,14,23,17,12,17,14,9,21]},
  {n:39,name:'Malachi',nameES:'Malaquías',v:[14,17,18,6]},
  {n:40,name:'Matthew',nameES:'Mateo',v:[25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20]},
  {n:41,name:'Mark',nameES:'Marcos',v:[45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20]},
  {n:42,name:'Luke',nameES:'Lucas',v:[80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53]},
  {n:43,name:'John',nameES:'Juan',v:[51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25]},
  {n:44,name:'Acts',nameES:'Hechos',v:[26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,40,38,40,30,35,27,27,32,44,31]},
  {n:45,name:'Romans',nameES:'Romanos',v:[32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27]},
  {n:46,name:'1 Corinthians',nameES:'1 Corintios',v:[31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24]},
  {n:47,name:'2 Corinthians',nameES:'2 Corintios',v:[24,17,18,18,21,18,16,24,15,18,33,21,14]},
  {n:48,name:'Galatians',nameES:'Gálatas',v:[24,21,29,31,26,18]},
  {n:49,name:'Ephesians',nameES:'Efesios',v:[23,22,21,32,33,24]},
  {n:50,name:'Philippians',nameES:'Filipenses',v:[30,30,21,23]},
  {n:51,name:'Colossians',nameES:'Colosenses',v:[29,23,25,18]},
  {n:52,name:'1 Thessalonians',nameES:'1 Tesalonicenses',v:[10,20,13,18,28]},
  {n:53,name:'2 Thessalonians',nameES:'2 Tesalonicenses',v:[12,17,18]},
  {n:54,name:'1 Timothy',nameES:'1 Timoteo',v:[20,15,16,16,25,21]},
  {n:55,name:'2 Timothy',nameES:'2 Timoteo',v:[18,26,17,22]},
  {n:56,name:'Titus',nameES:'Tito',v:[16,15,15]},
  {n:57,name:'Philemon',nameES:'Filemón',v:[25]},
  {n:58,name:'Hebrews',nameES:'Hebreos',v:[14,18,19,16,14,20,28,13,28,39,40,29,25]},
  {n:59,name:'James',nameES:'Santiago',v:[27,26,18,17,20]},
  {n:60,name:'1 Peter',nameES:'1 Pedro',v:[25,25,22,19,14]},
  {n:61,name:'2 Peter',nameES:'2 Pedro',v:[21,22,18]},
  {n:62,name:'1 John',nameES:'1 Juan',v:[10,29,24,21,21]},
  {n:63,name:'2 John',nameES:'2 Juan',v:[13]},
  {n:64,name:'3 John',nameES:'3 Juan',v:[14]},
  {n:65,name:'Jude',nameES:'Judas',v:[25]},
  {n:66,name:'Revelation',nameES:'Apocalipsis',v:[20,29,22,11,14,17,17,13,21,11,19,17,18,20,8,21,18,24,21,15,27,21]},
];
function bookName(b,lang){if(!b)return'';if(lang==='ES'&&b.nameES)return b.nameES;return b.name;}
function versionLang(vid){return PUBLIC_VERSIONS.find(v=>v.id===vid)?.lang||'EN';}
// A book name for a control too narrow to hold it. The map is the conventional
// English abbreviation, because a mechanical cut gives "Reve." and "Lame." and
// nobody reads those. Anything not in it — another language's names included —
// falls back to the first word cut short, which is what most of these are.
const BOOK_SHORT={'Leviticus':'Lev.','Numbers':'Num.','Deuteronomy':'Deut.','Nehemiah':'Neh.','Proverbs':'Prov.','Ecclesiastes':'Eccl.','Song of Solomon':'Song','Jeremiah':'Jer.','Lamentations':'Lam.','Ezekiel':'Ezek.','Obadiah':'Obad.','Habakkuk':'Hab.','Zephaniah':'Zeph.','Zechariah':'Zech.','Matthew':'Matt.','Philippians':'Phil.','Colossians':'Col.','Philemon':'Phlm.','Hebrews':'Heb.','Revelation':'Rev.','Ephesians':'Eph.','Galatians':'Gal.','Corinthians':'Cor.','Thessalonians':'Thess.','Chronicles':'Chr.','Samuel':'Sam.','Timothy':'Tim.'};
function shortBook(n){
  if(!n||n.length<=7)return n||'';
  if(BOOK_SHORT[n])return BOOK_SHORT[n];
  // "1 Thessalonians" abbreviates its second word and keeps the numeral.
  const m=n.match(/^([123])\s+(.+)$/);
  if(m)return m[1]+' '+(BOOK_SHORT[m[2]]||(m[2].length<=6?m[2]:m[2].slice(0,4)+'.'));
  return n.slice(0,5)+'.';
}

// Scrolls to a place the reader asked for by travelling there: the whole
// distance goes past, every verse between here and the book chosen. Animating
// only the last screenful and covering the rest outright was quicker still, but
// what it read as was a twitch on arrival rather than a journey.
//
// Duration grows with the square root of the distance, so the far end of the
// Bible takes about twice as long as the next book over rather than sixty times,
// and is capped either side: never so brief it flickers, never slow enough to
// wait on. Thirty thousand pixels in half a second is a blur, which is what
// scrolling that far fast looks like.
const GLIDE_MIN=220,GLIDE_MAX=520;
function glideTo(el,top,onDone){
  if(el._stopGlide)el._stopGlide(true);
  const end=Math.max(0,Math.min(el.scrollHeight-el.clientHeight,top));
  const from=el.scrollTop,span=end-from;
  if(Math.abs(span)<2){el.scrollTop=end;if(onDone)onDone();return;}
  const ms=Math.min(GLIDE_MAX,Math.max(GLIDE_MIN,Math.sqrt(Math.abs(span))*3));
  const t0=performance.now();
  // The flight is not interruptible. A touch used to end it where it stood,
  // which meant a thumb landing anywhere near the screen mid-blur stopped the
  // scroll on whatever book happened to be passing — the reader asked for one
  // book and was left in another, with nothing to say why. Half a second is
  // short enough to wait out, so the list is made inert for the duration and
  // the finger is answered when it lands.
  //
  // Unset rather than 'auto', so whatever the stylesheet says still applies
  // afterwards. The timer is the way back if frames never come at all — a
  // backgrounded app, a thread wedged somewhere — because a results list left
  // untouchable is a far worse failure than a scroll that skipped its
  // animation. It finishes the journey and hands the list back.
  el.style.pointerEvents='none';
  const stop=superseded=>{
    if(el._glide)cancelAnimationFrame(el._glide);
    clearTimeout(el._glideGuard);
    el._glide=0;el._glideGuard=0;el._stopGlide=null;
    el.style.pointerEvents='';
    if(onDone&&superseded!==true)onDone();
  };
  el._stopGlide=stop;
  el._glideGuard=setTimeout(()=>{el.scrollTop=end;stop();},ms+400);
  const step=now=>{
    const t=Math.min(1,(now-t0)/ms);
    // Cubic in and out: it gathers pace, runs, and comes to rest, which is what
    // makes the distance legible. Easing out alone starts at full speed, and a
    // scroll that is already at full speed on its first frame is a cut, not a
    // movement. A throttled frame — a backgrounded app, a stalled thread —
    // arrives with t already past 1 and simply finishes the scroll, so it can
    // never stall part-way there.
    el.scrollTop=from+span*(t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2);
    if(t<1)el._glide=requestAnimationFrame(step);
    else stop();
  };
  el._glide=requestAnimationFrame(step);
}

// Reads a typed reference — "john 3:16", "1 cor 13", "gen 1:1-5", "Éxodo 2" —
// so a reader who knows where they are going is not made to search for it. The
// book is matched in whatever language the version is in, on any prefix long
// enough to be unambiguous, which is what makes abbreviations work without a
// table of them. Returns null for anything that is not a reference, and a text
// search runs as normal.
function parseReference(raw,lang){
  if(!raw)return null;
  const s=raw.trim().replace(/\s+/g,' ');
  // An optional leading ordinal (1, 2, 3, I, II, III), the name, then numbers.
  const m=s.match(/^([123]|i{1,3})?\s*([\p{L}\s.]+?)\s*(\d+)?\s*(?::\s*(\d+))?\s*(?:-\s*\d+)?$/iu);
  if(!m)return null;
  const ord=m[1]?(/^[123]$/.test(m[1])?m[1]:String(m[1].length)):'';
  const namePart=(m[2]||'').replace(/\./g,'').trim();
  if(namePart.length<2)return null;
  const chapter=m[3]?parseInt(m[3],10):null;
  const verse=m[4]?parseInt(m[4],10):null;
  const norm=t=>String(t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
  const bare=norm(namePart);
  const cands=BIBLE.map(b=>({b,full:norm(bookName(b,lang))}));
  let hits;
  if(ord){
    hits=cands.filter(c=>c.full.startsWith(norm(ord+' '+namePart)));
  }else{
    // "john" names John, even though it also begins 1, 2 and 3 John — an exact
    // name beats a prefix, or the most-typed reference in the Bible would be
    // rejected as ambiguous.
    const exact=cands.filter(c=>c.full===bare);
    if(exact.length===1)hits=exact;
    else{
      const plain=cands.filter(c=>!/^[123] /.test(c.full)&&c.full.startsWith(bare));
      hits=plain.length?plain:cands.filter(c=>c.full.startsWith(bare));
    }
  }
  // Still ambiguous ("jo" could be Job, Joel, Jonah, Joshua, John) is not a
  // reference yet — the reader may be typing a word.
  if(hits.length!==1)return null;
  const b=hits[0].b;
  // A chapter that does not exist is a typo, not a destination. Saying nothing
  // beats offering to jump somewhere they did not ask for.
  if(chapter!==null&&(chapter<1||chapter>b.v.length))return null;
  const ch=chapter||1;
  const maxV=b.v[ch-1]||1;
  // A verse out of range falls back to the chapter rather than to its last verse.
  const vs=(verse!==null&&verse>=1&&verse<=maxV)?verse:null;
  return{book:b,book_num:b.n,chapter:ch,verse:vs};
}

// ── Reading plan ──────────────────────────────────────────────
// Meek's Daily Bible Reading Plan: 52 weeks of a Psalm on Sunday and a paired
// Old and New Testament reading the other six days.
//
// The printed plan is numbered by week and assumes you begin on a Sunday. This
// anchors week 1 to the first Sunday of the year instead, so the Psalms always
// fall on a real Sunday. 52 x 7 = 364 is a whole number of weeks, so wrapping
// the few days before that first Sunday back onto the end of week 52 covers
// them without knocking any weekday off its own row.
const PLAN_DAYS=365;
const PLAN_CYCLE=MEEK_WEEKS.length*7;
function planFirstSunday(year){
  for(let d=1;d<=7;d++)if(new Date(year,0,d).getDay()===0)return d;
  return 1;
}
const _yearPlans={};
function buildYearPlan(year){
  if(_yearPlans[year])return _yearPlans[year];
  const fs=planFirstSunday(year);
  const out=Array.from({length:PLAN_DAYS},(_,i)=>{
    const day=i+1;
    const idx=((day-fs)%PLAN_CYCLE+PLAN_CYCLE)%PLAN_CYCLE;
    const week=Math.floor(idx/7),row=idx%7;
    const[ps,ot,nt]=MEEK_WEEKS[week];
    return row===0?{day,week:week+1,ot:[ps],nt:[]}
                  :{day,week:week+1,ot:[ot[row-1]],nt:[nt[row-1]]};
  });
  _yearPlans[year]=out;
  return out;
}
// A reading is [book, fromChapter, fromVerse, toChapter, toVerse]. Verse 0 means
// the whole chapter; one that spans a whole book is shown as just its name.
function planRefLabel(r,lang,short){
  const[b,c1,v1,c2,v2]=r;
  const bk=BIBLE.find(x=>x.n===b);
  if(!bk)return'';
  const full=bookName(bk,lang),nm=short?shortBook(full):full,last=bk.v.length;
  if(c1===1&&c2===last&&!v1&&!v2)return nm;
  if(!v1&&!v2)return c1===c2?`${nm} ${c1}`:`${nm} ${c1}\u2013${c2}`;
  if(c1===c2)return `${nm} ${c1}:${v1||1}\u2013${v2||bk.v[c2-1]}`;
  return `${nm} ${c1}:${v1||1}\u2013${c2}:${v2||bk.v[c2-1]}`;
}
const _planLabels={};
function planYearLabels(year,lang){
  const k=year+':'+lang;
  if(!_planLabels[k])_planLabels[k]=buildYearPlan(year).map(e=>
    [...e.ot,...e.nt].map(r=>({b:r[0],c:r[1],v:r[2]||1,c2:r[3]||r[1],label:planRefLabel(r,lang),short:planRefLabel(r,lang,true)})));
  return _planLabels[k];
}
function planDayOfYear(d=new Date()){
  return Math.max(1,Math.min(PLAN_DAYS,Math.floor((d-new Date(d.getFullYear(),0,0))/86400000)));
}
function planDateLabel(day,year){
  const dt=new Date(year,0,1); dt.setDate(day);
  return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
// Reminders are scheduled one per day with that day's actual passages, rather
// than one repeating notification with generic text — the point is to see what
// today's reading is without opening anything. iOS caps pending notifications
// at 64, so this books a month ahead and tops up whenever the plan is opened.
const PLAN_REMIND_KEY='scrip:plan:remind:v1';
const PLAN_REMIND_TIME='07:00'; // where the picker starts, and what switching off resets to
const PLAN_NOTIF_BASE=9000;
const PLAN_NOTIF_SPAN=30;
function planRemindLoad(){
  try{const r=JSON.parse(localStorage.getItem(PLAN_REMIND_KEY)||'null');
      return r&&typeof r.time==='string'?{on:!!r.on,time:r.time}:{on:false,time:PLAN_REMIND_TIME};}
  catch{return{on:false,time:PLAN_REMIND_TIME};}
}
function planRemindSave(v){try{localStorage.setItem(PLAN_REMIND_KEY,JSON.stringify(v));}catch{}}
function planTimeLabel(t){
  const[h,m]=String(t||'07:00').split(':').map(Number);
  if(!Number.isFinite(h)||!Number.isFinite(m))return t;
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;
}
async function planSyncReminders(on,time,year,lang){
  if(!Capacitor.isNativePlatform())return{ok:!on};
  try{
    const pending=await LocalNotifications.getPending();
    const mine=(pending.notifications||[]).filter(n=>n.id>=PLAN_NOTIF_BASE&&n.id<PLAN_NOTIF_BASE+400);
    if(mine.length)await LocalNotifications.cancel({notifications:mine.map(n=>({id:n.id}))});
    if(!on)return{ok:true};
    let perm=await LocalNotifications.checkPermissions();
    if(perm.display!=='granted')perm=await LocalNotifications.requestPermissions();
    if(perm.display!=='granted')return{ok:false,denied:true};
    const[h,m]=String(time).split(':').map(Number);
    const labels=planYearLabels(year,lang),today=planDayOfYear(),now=new Date(),list=[];
    for(let i=0;i<PLAN_NOTIF_SPAN;i++){
      const day=today+i;
      if(day>PLAN_DAYS)break;
      const at=new Date(year,0,day,h||0,m||0,0,0);
      if(at<=now)continue;
      list.push({id:PLAN_NOTIF_BASE+day,title:'Today\u2019s reading',
        body:labels[day-1].map(r=>r.label).join(' \u00b7 '),
        schedule:{at,allowWhileIdle:true}});
    }
    if(list.length)await LocalNotifications.schedule({notifications:list});
    return{ok:true,count:list.length};
  }catch{return{ok:false};}
}
const PLAN_KEY='scrip:plan:v3';
function planLoad(){
  try{
    const raw=JSON.parse(localStorage.getItem(PLAN_KEY)||'null');
    // A new year is a fresh run through, so old ticks do not carry over.
    if(!raw||raw.year!==new Date().getFullYear())return{year:new Date().getFullYear(),done:[]};
    return{year:raw.year,done:Array.isArray(raw.done)?raw.done:[]};
  }catch{return{year:new Date().getFullYear(),done:[]};}
}
function planSave(state){try{localStorage.setItem(PLAN_KEY,JSON.stringify(state));}catch{}}
// ── Words of Jesus (Red Letter) — compact ranges per book:chapter ──
// Format: {bookNum:{chapter:"v1-v2,v3,v4-v5",...}}
const WOJ_RAW={
40:{3:"15",4:"4,7,10,17,19",5:"3-48",6:"1-34",7:"1-27",8:"4,7,10-13,20,22,26,32",9:"2,4-6,9,12-13,15,22,24,28-30,37-38",10:"5-42",11:"4-6,7-11,14-15,17,20-30",12:"3-8,11-12,25-37,39-45,48-50",13:"11-17,18-23,24-30,31-33,37-43,44-52,57",14:"16,18,27,29,31",15:"3-11,13-14,16-20,24,26,28,32,34",16:"2-4,6,8-11,13,15,17-19,23-28",17:"7,9,11-12,17,20-21,22-23,25-27",18:"3-4,7-14,17-20,22-35",19:"4-6,8-12,14,17-21,23-24,26,28-30",20:"1-16,18-19,21-23,25-28,32",21:"2-3,13,16,19,21-22,24-27,28-31,33-44",22:"4-14,18-21,29-32,37-40,42-45",23:"2-39",24:"2,4-35,42-51",25:"1-13,14-30,31-46",26:"2,10-13,18,21,23-29,31-32,34,36,38,40-41,45-46,50,52-54,55-56,64",27:"11,46",28:"9-10,18-20"},
41:{1:"15,17,25,38,41,44",2:"5,8-11,14,17,19-22,24-28",3:"3-5,23-29,33-35",4:"3-9,11-12,13-20,21-25,26-29,30-32,35,39-40",5:"8-9,19,30,34,36,39,41",6:"4,10,31,37-38,50",7:"6-13,14-16,18-23,27,29,34",8:"1-2,5,12,15,17-21,29,33-38",9:"1,12-13,16,19,21,23,25,29,31,33,35-37,39-41,43-50",10:"3,5-9,11-12,14-15,18-21,23-27,29-31,33-34,36,38-40,42-45,47,49,51-52",11:"2-3,6,14,15-17,22-26,29-33",12:"6,9-11,15-17,24-27,29-31,35-37,38-40,43-44",13:"2,5-37",14:"6,13-15,18,20-25,27-28,30,32,34,36,38,41-42,48-49,62",15:"2,34",16:"15-18"},
42:{2:"49",4:"4,8,12,18-21,23-27,35,43",5:"4,10,12-13,20,22-24,27,31-32,33-39",6:"3-5,8-10,20-49",7:"9,13-14,22-28,31-35,40-48,50",8:"5-8,10-15,17-18,21-22,25,30,35,39,45-46,48,50,52,54",9:"3-5,12-14,18-20,22-27,35,41,44,48-50,54,57-62",10:"2-16,18-24,26,28,30-37,41-42",11:"2-13,17-26,28-36,39-52",12:"1-12,14-40,42-59",13:"2-5,7-9,12,15-16,18-21,23-30,32-35",14:"3,5,16-24,26-35",15:"3-7,8-10,11-32",16:"9,15,17,29-31",17:"1-4,6-10,14,17,19-37",18:"2-8,14,16-17,19-22,24-30,31-34,37,40-42",19:"5,9-10,12-27,30-31,40,42-44,46",20:"3-8,17-18,23-25,34-38,41-44,46",21:"3-4,5-36",22:"8-13,15-22,25-34,36-38,40,42,46,48,51,52-53,67-70",23:"3,28-31,34,43,46",24:"5,17,19,25-27,36,38-41,44-49"},
43:{1:"38-39,42-43,47,50-51",2:"4,7-8,16,19",3:"3,5-8,10-21",4:"7,10,13-14,16-18,21-24,26,32-35,38,48,50",5:"6,8,10-47",6:"5,10,12,20,26-65,67,70",7:"6-8,16-19,21-24,33-34,37-38",8:"7,10-12,14-18,19,21,23-26,28-29,31-38,39-47,49-51,54-56,58",9:"3-5,7,35,37,39,41",10:"1-18,25-30,32,34-38",11:"4,7,9-11,14-15,23,25-26,34,39-44",12:"7-8,23-28,30,32,35-36,44-50",13:"7-8,10-21,25-27,31-38",14:"1-31",15:"1-27",16:"1-33",17:"1-26",18:"4-5,7-9,11,20-21,23,34,36-37",19:"26-28,30",20:"15-17,19,21-23,26-27,29",21:"5-6,10,12,15-19,22-23"},
44:{1:"4-5,7-8",9:"4-6,10-12,15-16",10:"13,15",11:"7,9",18:"9-10",22:"7-8,10,18,21",23:"11",26:"14-18"},
66:{1:"8,11,17-20",2:"1-29",3:"1-22",16:"15",21:"5-8",22:"7,12-13,16,20"}
};
// Parse WOJ_RAW into a fast lookup Set
const WOJ=new Set();
(function(){for(const[bk,chs]of Object.entries(WOJ_RAW)){for(const[ch,ranges]of Object.entries(chs)){ranges.split(',').forEach(r=>{const m=r.match(/^(\d+)-(\d+)$/);if(m){for(let v=+m[1];v<=+m[2];v++)WOJ.add(bk+':'+ch+':'+v);}else WOJ.add(bk+':'+ch+':'+r);});}}})();
function isWOJ(bookNum,chapter,verse){return WOJ.has(bookNum+':'+chapter+':'+verse);}
const ABBREVS={gen:'Genesis',ex:'Exodus',exo:'Exodus',lev:'Leviticus',num:'Numbers',deut:'Deuteronomy',dt:'Deuteronomy',josh:'Joshua',judg:'Judges',jdg:'Judges',ruth:'Ruth','1sam':'1 Samuel','2sam':'2 Samuel','1kgs':'1 Kings','1ki':'1 Kings','2kgs':'2 Kings','2ki':'2 Kings','1chr':'1 Chronicles','2chr':'2 Chronicles',ezr:'Ezra',neh:'Nehemiah',esth:'Esther',job:'Job',ps:'Psalms',psa:'Psalms',psalm:'Psalms',prov:'Proverbs',pr:'Proverbs',eccl:'Ecclesiastes',song:'Song of Solomon',sos:'Song of Solomon',isa:'Isaiah',jer:'Jeremiah',lam:'Lamentations',ezek:'Ezekiel',eze:'Ezekiel',dan:'Daniel',hos:'Hosea',joel:'Joel',amos:'Amos',obad:'Obadiah',jon:'Jonah',mic:'Micah',nah:'Nahum',hab:'Habakkuk',zeph:'Zephaniah',hag:'Haggai',zech:'Zechariah',mal:'Malachi',matt:'Matthew',mt:'Matthew',mk:'Mark',lk:'Luke',jn:'John',joh:'John',act:'Acts',rom:'Romans','1cor':'1 Corinthians','2cor':'2 Corinthians',gal:'Galatians',eph:'Ephesians',phil:'Philippians',php:'Philippians',col:'Colossians','1thess':'1 Thessalonians','2thess':'2 Thessalonians','1tim':'1 Timothy','2tim':'2 Timothy',tit:'Titus',phlm:'Philemon',heb:'Hebrews',jas:'James','1pet':'1 Peter','2pet':'2 Peter','1jn':'1 John','2jn':'2 John','3jn':'3 John',jude:'Jude',rev:'Revelation',apoc:'Revelation'};
const ISSUE_TYPES=['manuscript','word','omission','article','grammar','doctrine','name','other'];
const STATUS_VALUES=['reference','faithful','corrupt','diff','partial','missing'];
const STATUS_LABELS={reference:'Reference',faithful:'Faithful',corrupt:'Corrupt / Alexandrian',diff:'Differs',partial:'Partial',missing:'Absent'};
const ISSUE_LABELS={manuscript:'Manuscript',word:'Word Choice',omission:'Omission',article:'Article',grammar:'Grammar',doctrine:'Doctrine',name:'Name/Title',other:'Other'};
const PUBLIC_VERSIONS=[{id:'kjv',label:'KJV',lang:'EN',isRef:true},{id:'rvg',label:'RVG',lang:'ES',isRef:false},{id:'p1602',label:'1602P',lang:'ES',isRef:false}];
// Webster's 1828 dictionary: 107,793 entries in Supabase table webster_1828
// Queried via RPC: search_webster_1828(query_term)

// ══════════════════════════════════════════════════════════
//  THEME
// ══════════════════════════════════════════════════════════
const D={bg:'#0e0d0b',bg2:'#141311',bgCard:'#191815',bgCH:'#1f1e1a',bgSec:'#151412',bgIn:'#0e0d0b',bd:'#28251e',bdA:'#38332a',bdS:'#1e1c16',g:'#c8a84e',gT:'#e4cc78',gM:'#8a7a48',gD:'#4a3e22',gF:'#1e1a0e',body:'#ede4cf',mut:'#bfb090',dim:'#6a5e46',blue:'#0c1e32',blueTxt:'#7aaed8',green:'#0a2414',greenTxt:'#62c484',dif:'#0c2218',difTxt:'#7ab888',red:'#2a0c0c',redTxt:'#d46868',amb:'#241a06',ambTxt:'#cc9a38',pur:'#14082a',purTxt:'#9468c0',ora:'#221208',oraTxt:'#c87828',accentLine:'linear-gradient(90deg, transparent, #4a3e22, #c8a84e, #4a3e22, transparent)'};
const L={bg:'#f6f3ec',bg2:'#f0ece3',bgCard:'#faf8f4',bgCH:'#f0ece3',bgSec:'#ebe6db',bgIn:'#faf8f4',bd:'#d4ccba',bdA:'#c0b090',bdS:'#ddd6c6',g:'#8a6420',gT:'#4a3008',gM:'#7a6040',gD:'#c0a068',gF:'#f0e8d4',body:'#1a1208',mut:'#3a2e18',dim:'#6a5a40',blue:'#dceaf8',blueTxt:'#1a4a8a',green:'#d2ecde',greenTxt:'#186030',dif:'#d8ecda',difTxt:'#2a7038',red:'#f6d8d8',redTxt:'#920e0e',amb:'#f8eacc',ambTxt:'#835000',pur:'#ece0f5',purTxt:'#5a2080',ora:'#fae0c0',oraTxt:'#7a3800',accentLine:'linear-gradient(90deg, transparent, #c0a068, #8a6420, #c0a068, transparent)'};
const BD={manuscript:{bg:'#260808',txt:'#c86060',bd:'#4a1212'},word:{bg:'#221806',txt:'#b88828',bd:'#483008'},omission:{bg:'#180820',txt:'#9060b8',bd:'#341460'},article:{bg:'#081a1a',txt:'#48b8b8',bd:'#164040'},grammar:{bg:'#081220',txt:'#58a0c0',bd:'#163050'},doctrine:{bg:'#201008',txt:'#b86828',bd:'#482408'},name:{bg:'#1c1608',txt:'#b8a848',bd:'#403808'},other:{bg:'#161310',txt:'#786248',bd:'#342a1c'}};
const BL={manuscript:{bg:'#f5d5d5',txt:'#8a0e0e',bd:'#c03030'},word:{bg:'#f8e8c0',txt:'#7a4a00',bd:'#b87820'},omission:{bg:'#ecd8f5',txt:'#521880',bd:'#8858b8'},article:{bg:'#cceeee',txt:'#0a5a5a',bd:'#287878'},grammar:{bg:'#cce4f0',txt:'#0a3858',bd:'#285878'},doctrine:{bg:'#f5dcc8',txt:'#702800',bd:'#b85818'},name:{bg:'#eeeac0',txt:'#524800',bd:'#888000'},other:{bg:'#e8e2d8',txt:'#524838',bd:'#908070'}};
function stSt(s,T){switch(s){case'reference':return{bg:T.blue,txt:T.blueTxt};case'faithful':return{bg:T.green,txt:T.greenTxt};case'corrupt':return{bg:T.red,txt:T.redTxt};case'diff':return{bg:T.dif,txt:T.difTxt};case'partial':return{bg:T.ora,txt:T.oraTxt};case'missing':return{bg:T.pur,txt:T.purTxt};default:return{bg:T.bgCard,txt:T.dim};}}
function hexToHsl(hex){let r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h,s,l=(mx+mn)/2;if(mx===mn){h=s=0;}else{const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);if(mx===r)h=(g-b)/d+(g<b?6:0);else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h/=6;}return[Math.round(h*360),Math.round(s*100),Math.round(l*100)];}
function hslToHex(h,s,l){h=((h%360)+360)%360;s=Math.max(0,Math.min(100,s));l=Math.max(0,Math.min(100,l));s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));};return'#'+[0,8,4].map(n=>Math.round(f(n)*255).toString(16).padStart(2,'0')).join('');}
function buildCustomPalette(hex){
  const[h,s,l]=hexToHsl(hex);
  const cs=Math.min(s,85);
  const cl=Math.max(20,Math.min(70,l));
  // Backgrounds/borders carry a very faint hue tint (matching how preset themes work)
  const bs=Math.min(cs*0.10,8);    // background saturation — barely perceptible
  const bsB=Math.min(cs*0.18,14);  // border saturation — slightly more visible
  const bsT=Math.min(cs*0.25,20);  // text/body saturation
  return{
    dark:{
      g:hslToHex(h,cs,cl),gT:hslToHex(h,Math.max(cs-10,30),Math.min(cl+20,88)),
      gM:hslToHex(h,Math.max(cs-25,15),Math.max(cl-15,25)),
      gD:hslToHex(h,Math.min(cs+5,90),Math.max(cl-35,8)),
      gF:hslToHex(h,Math.min(cs,80),Math.max(cl-50,3)),
      bg:hslToHex(h,bs,5),bg2:hslToHex(h,bs,7),
      bgCard:hslToHex(h,Math.max(bs-1,2),9),bgCH:hslToHex(h,Math.max(bs-1,2),11),
      bgSec:hslToHex(h,bs,8),bgIn:hslToHex(h,bs,5),
      bd:hslToHex(h,bsB,14),bdA:hslToHex(h,bsB,20),bdS:hslToHex(h,Math.max(bsB-3,2),10),
      body:hslToHex(h,bsT,88),mut:hslToHex(h,Math.min(cs*0.15,12),70),dim:hslToHex(h,Math.min(cs*0.12,8),40),
    },
    light:{
      g:hslToHex(h,cs,Math.max(cl-20,15)),gT:hslToHex(h,Math.min(cs+10,90),Math.max(cl-40,5)),
      gM:hslToHex(h,Math.max(cs-15,20),Math.max(cl-10,20)),
      gD:hslToHex(h,Math.max(cs-15,30),Math.min(cl+15,72)),
      gF:hslToHex(h,Math.max(cs-35,8),Math.min(cl+38,97)),
      bg:hslToHex(h,bs,96),bg2:hslToHex(h,bs,93),
      bgCard:hslToHex(h,Math.max(bs-1,2),98),bgCH:hslToHex(h,bs,93),
      bgSec:hslToHex(h,bs,91),bgIn:hslToHex(h,Math.max(bs-1,2),98),
      bd:hslToHex(h,bsB,82),bdA:hslToHex(h,bsB,72),bdS:hslToHex(h,Math.max(bsB-3,2),87),
      body:hslToHex(h,bsT,8),mut:hslToHex(h,Math.min(cs*0.18,15),22),dim:hslToHex(h,Math.min(cs*0.12,8),40),
    }
  };
}

const ACCENTS={
  gold:      {dark:{g:'#c8a84e',gT:'#e4cc78',gM:'#8a7a48',gD:'#4a3e22',gF:'#1e1a0e'},light:{g:'#8a6420',gT:'#4a3008',gM:'#7a6040',gD:'#c0a068',gF:'#f0e8d4'}},
  slate:     {dark:{g:'#b0b0b0',gT:'#e4e4e4',gM:'#707070',gD:'#383838',gF:'#0e0e0e',body:'#e4e4e4',mut:'#a8a8a8',dim:'#686868',bg:'#0b0b0b',bg2:'#101010',bgCard:'#151515',bgCH:'#1a1a1a',bgSec:'#121212',bgIn:'#0b0b0b',bd:'#242424',bdA:'#303030',bdS:'#1a1a1a'},      light:{g:'#404040',gT:'#1a1a1a',gM:'#585858',gD:'#909090',gF:'#e4e4e4',body:'#181818',mut:'#404040',dim:'#686868',bg:'#f5f5f5',bg2:'#ebebeb',bgCard:'#fafafa',bgCH:'#ebebeb',bgSec:'#e8e8e8',bgIn:'#fafafa',bd:'#c8c8c8',bdA:'#b0b0b0',bdS:'#d8d8d8'}},
  terracotta:{dark:{g:'#cc5848',gT:'#f0a890',gM:'#8c4038',gD:'#4e1e18',gF:'#150808',body:'#ece0dc',mut:'#b8a8a4',dim:'#706058',bg:'#0c0b0b',bg2:'#111010',bgCard:'#161413',bgCH:'#1b1918',bgSec:'#131211',bgIn:'#0c0b0b',bd:'#281a18',bdA:'#342220',bdS:'#1e1614'},      light:{g:'#a02820',gT:'#501010',gM:'#803028',gD:'#c87068',gF:'#f8e8e4',body:'#200808',mut:'#401818',dim:'#703030',bg:'#f6f5f4',bg2:'#eeeceb',bgCard:'#fafaf9',bgCH:'#eeeceb',bgSec:'#eae9e8',bgIn:'#fafaf9',bd:'#d4a09c',bdA:'#b88880',bdS:'#e0c0bc'}},
  steel:     {dark:{g:'#5898c0',gT:'#a0d0f0',gM:'#40708a',gD:'#1e3858',gF:'#09121c',body:'#dce4ec',mut:'#9ab0c4',dim:'#586878',bg:'#0b0c0d',bg2:'#0e0f10',bgCard:'#141516',bgCH:'#191a1b',bgSec:'#111213',bgIn:'#0b0c0d',bd:'#1e2428',bdA:'#272e34',bdS:'#161c20'},    light:{g:'#1e4870',gT:'#0c2440',gM:'#2a5070',gD:'#6898c0',gF:'#d8eaf8',body:'#0c1824',mut:'#283a50',dim:'#406070',bg:'#f4f5f6',bg2:'#ebecee',bgCard:'#f9fafb',bgCH:'#ebecee',bgSec:'#e8e9eb',bgIn:'#f9fafb',bd:'#b0c4d8',bdA:'#98aec4',bdS:'#c8d8e8'}},
  sage:      {dark:{g:'#414524',gT:'#6a7038',gM:'#2e3018',gD:'#1e2010',gF:'#0e1006',body:'#c8ceb0',mut:'#7a7e60',dim:'#4c5038',bg:'#0b0c0b',bg2:'#0e0f0e',bgCard:'#131413',bgCH:'#181918',bgSec:'#101110',bgIn:'#0b0c0b',bd:'#1e2012',bdA:'#282a1a',bdS:'#161810'},        light:{g:'#414524',gT:'#1e2010',gM:'#4e5228',gD:'#6a6e40',gF:'#d4d8b0',body:'#1c1e10',mut:'#2e3020',dim:'#484c30',bg:'#f4f5f4',bg2:'#ebeceb',bgCard:'#f9faf9',bgCH:'#ebeceb',bgSec:'#e8e9e8',bgIn:'#f9faf9',bd:'#9a9e70',bdA:'#828660',bdS:'#b4b888'}},
  heather:   {dark:{g:'#9078c0',gT:'#c8b0e8',gM:'#605080',gD:'#342054',gF:'#0e0914',body:'#dcdae8',mut:'#a09cb8',dim:'#5c5870',bg:'#0b0b0e',bg2:'#101013',bgCard:'#151518',bgCH:'#1a1a1e',bgSec:'#121215',bgIn:'#0b0b0e',bd:'#21202a',bdA:'#2a2935',bdS:'#191820'},    light:{g:'#503880',gT:'#281840',gM:'#5c4278',gD:'#9880c8',gF:'#ece4f8',body:'#181028',mut:'#382448',dim:'#604878',bg:'#f5f4f6',bg2:'#edecef',bgCard:'#faf9fb',bgCH:'#edecef',bgSec:'#eae9ec',bgIn:'#faf9fb',bd:'#c0b0d8',bdA:'#a898c4',bdS:'#d4cce8'}},
  rose:      {dark:{g:'#e04880',gT:'#f090b8',gM:'#903060',gD:'#541030',gF:'#160610',body:'#ecdae4',mut:'#b898a8',dim:'#705868',bg:'#0e0b0c',bg2:'#131011',bgCard:'#181415',bgCH:'#1d1819',bgSec:'#141213',bgIn:'#0e0b0c',bd:'#2a0e1c',bdA:'#381428',bdS:'#1e0814'},        light:{g:'#c01860',gT:'#600828',gM:'#9a2050',gD:'#e060a0',gF:'#fce8f4',body:'#280810',mut:'#481020',dim:'#801840',bg:'#f6f4f5',bg2:'#eeecee',bgCard:'#fbf9fa',bgCH:'#eeecee',bgSec:'#ebe9ea',bgIn:'#fbf9fa',bd:'#e090b8',bdA:'#c870a0',bdS:'#f0b8d0'}},
  sienna:    {dark:{g:'#d06828',gT:'#f0a060',gM:'#904820',gD:'#4e2010',gF:'#140a04',body:'#e4d8c8',mut:'#b09070',dim:'#705838',bg:'#0c0b0a',bg2:'#111009',bgCard:'#161411',bgCH:'#1b1914',bgSec:'#131210',bgIn:'#0c0b0a',bd:'#28140a',bdA:'#341c0e',bdS:'#1e1008'},        light:{g:'#8a3010',gT:'#401808',gM:'#7a3818',gD:'#d07040',gF:'#faecd8',body:'#1e0e04',mut:'#3c1c08',dim:'#704020',bg:'#f6f5f4',bg2:'#eeeceb',bgCard:'#fbfaf9',bgCH:'#eeeceb',bgSec:'#eae9e7',bgIn:'#fbfaf9',bd:'#d0a070',bdA:'#b88858',bdS:'#e0c090'}},
};
const FS="'Cinzel',Georgia,serif";
const FB="'Cormorant Garamond','EB Garamond',Georgia,serif";
const fontFamilyMap={serif:FB,sans:"'Source Sans 3','Segoe UI',system-ui,sans-serif",mono:"'Inconsolata','SFMono-Regular','Courier New',monospace"};

// Interface type follows the reading size, but never one for one: a 9px label
// scaled the way a 31px verse is would swamp the row it labels. Three ramps,
// each compressing the slider's travel by its own factor, all capped at 1.35x
// and floored at 1 so nothing moves until the slider passes its default.
// The fallback of 1 is the whole revert story -- drop the <style> these read
// from and every one of these resolves to the number it was written as.
const U =n=>`calc(${n}px * var(--ui-s,1))`;  // UI body copy: FB, 11-16px
const UL=n=>`calc(${n}px * var(--ui-l,1))`;  // micro-labels: FS, 10px and under
const UH=n=>`calc(${n}px * var(--ui-h,1))`;  // headings: 17px and up

// Everything the Reading Appearance section owns, in one place. The state
// initialisers and the reset button both read it, so the defaults cannot drift
// apart the way two hand-kept copies of the same nine values would. Keys are
// the localStorage name after the scrip: prefix.
const AD={accent:'gold',accentCustom:'#c8a84e',fontSize:31,uiSize:100,lineHeight:1.2,
  fontFamily:'serif',verseNums:'super',textAlign:'left',paraMode:false,redLetter:true};

const CSS=`
/* Fonts are bundled and loaded from public/fonts/fonts.css via index.html.
   Fetching them from Google here meant a first offline launch fell back to Georgia. */
*{box-sizing:border-box;margin:0;padding:0;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--ac-scrollbar,#3a3020);border-radius:10px;}
mark.sch{background:var(--ac-mark,rgba(200,168,78,0.22));color:inherit;border-radius:2px;padding:0 2px;}
/* Touch devices keep :hover after a tap, so a tapped control stayed lit until
   something else was tapped. Every :hover below is pointer-only. This sheet is
   injected at runtime and shadows src/index.css — change both together. */
.hov-card{transition:border-color .3s,box-shadow .3s,transform .3s;}
@media (hover:hover){.hov-card:hover{border-color:var(--ac-bd,#38332a)!important;box-shadow:0 6px 28px rgba(0,0,0,0.3)!important;transform:translateY(-1px);}}
.s-btn{transition:all .2s;cursor:pointer;}
@media (hover:hover){.s-ghost:hover{background:var(--ac-ghost-bg,rgba(200,168,78,0.09))!important;border-color:var(--ac-ghost-bd,rgba(200,168,78,0.3))!important;}}
@media (hover:hover){.s-tbtn:hover{border-color:var(--ac-tbtn-bd,rgba(200,168,78,0.5))!important;background:var(--ac-tbtn-bg,rgba(200,168,78,0.06))!important;}}
@media (hover:hover){.s-danger:hover{border-color:#aa2828!important;color:#e05555!important;background:rgba(180,30,30,0.12)!important;}}
button:focus-visible{outline:2px solid var(--ac-focus,rgba(200,168,78,0.4));outline-offset:1px;}
.pulse{animation:pulse-glow .6s ease-in-out 3;}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes pulse-glow{0%,100%{box-shadow:0 0 0 0 var(--ac-pulse0,rgba(200,168,78,0));}50%{box-shadow:0 0 0 6px var(--ac-pulse50,rgba(200,168,78,0.25));}}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes slideDown{from{opacity:0;transform:translateY(-10px) scaleY(0.96);}to{opacity:1;transform:translateY(0) scaleY(1);}}
@keyframes slideUp{from{opacity:0;transform:translateY(100%);}to{opacity:1;transform:translateY(0);}}
@keyframes sheetOpen{from{transform:translateY(100%);}to{transform:translateY(0);}}
@keyframes sheetClose{from{transform:translateY(0);}to{transform:translateY(105%);}}
@keyframes backdropIn{from{opacity:0;}to{opacity:1;}}
@keyframes backdropOut{from{opacity:1;}to{opacity:0;}}
@keyframes slideUpStrip{from{transform:translateY(100%);}to{transform:translateY(0);}}
@keyframes slideDownStrip{from{transform:translateY(0);}to{transform:translateY(100%);}}
@keyframes slideUpOut{from{transform:translateY(0);}to{transform:translateY(-100%);}}
@keyframes slideDownOut{from{transform:translateY(0);}to{transform:translateY(100%);}}
@keyframes slideDownIn{from{transform:translateY(-100%);}to{transform:translateY(0);}}
@keyframes slideUpIn{from{transform:translateY(100%);}to{transform:translateY(0);}}
.fs-header-out{animation:slideUpOut .18s ease-in both;}
.fs-header-in{animation:slideDownIn .18s ease-out both;}
.fs-bar-out{animation:slideDownOut .18s ease-in both;}
.fs-bar-in{animation:slideUpIn .18s ease-out both;}
@keyframes slideDownSheet{from{opacity:0;transform:translateY(-100%);}to{opacity:1;transform:translateY(0);}}
@keyframes modalIn{from{opacity:0;transform:scale(0.93) translateY(14px);}to{opacity:1;transform:scale(1) translateY(0);}}
@keyframes modalInTop{from{opacity:0;transform:translateY(-100%);}to{opacity:1;transform:translateY(0);}}
@keyframes shimmer{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
@keyframes breathe{0%,100%{opacity:.4;}50%{opacity:1;}}
@keyframes goldLine{0%{background-position:-100% 0;}100%{background-position:200% 0;}}
@keyframes textReveal{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
.fade-up{animation:fadeUp .35s ease-out both;}
.fade-in{animation:fadeIn .3s ease-out both;}
.slide-down{animation:slideDown .3s cubic-bezier(0.34,1.4,0.64,1) both;}
.slide-up-sheet{animation:slideUp .3s cubic-bezier(0.32,0.72,0,1) both;}
.slide-up-strip{animation:slideUpStrip .18s cubic-bezier(0.34,1.2,0.64,1) both;}
.slide-down-strip{animation:slideDownStrip .15s ease-in both;}
.slide-down-sheet{animation:slideDownSheet .3s cubic-bezier(0.32,0.72,0,1) both;}
@keyframes slideDownSheetOut{from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(-100%);}}
@keyframes slideUpSheetOut{from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(100%);}}
.slide-down-sheet-out{animation:slideDownSheetOut .25s ease-in both;}
.slide-up-sheet-out{animation:slideUpSheetOut .25s ease-in both;}
/* Search drops in from behind the nav and lifts back into it, the way the
   version sheet does. The bar carries the slide; the page under it only
   cross-fades, because a transform there would make the search bar's
   own position:fixed resolve against it instead of the screen. */
@keyframes srchDrop{from{opacity:0;transform:translateY(-100%);}to{opacity:1;transform:translateY(0);}}
@keyframes srchLift{from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(-100%);}}
.srch-drop{animation:srchDrop .26s cubic-bezier(0.32,0.72,0,1) both;}
.srch-lift{animation:srchLift .2s ease-in both;}
@keyframes srchBodyIn{from{opacity:0;}to{opacity:1;}}
@keyframes srchBodyOut{from{opacity:1;}to{opacity:0;}}
.srch-body-in{animation:srchBodyIn .22s ease-out both;}
.srch-body-out{animation:srchBodyOut .18s ease-in both;}
.modal-in{animation:modalIn .28s cubic-bezier(0.34,1.4,0.64,1) both;}
.section-enter{animation:fadeUp .4s cubic-bezier(0.34,1.2,0.64,1) both;}
.text-reveal{animation:textReveal .35s ease-out both;}
.stagger-1{animation-delay:.05s;}.stagger-2{animation-delay:.1s;}.stagger-3{animation-delay:.15s;}.stagger-4{animation-delay:.2s;}.stagger-5{animation-delay:.25s;}
.gold-shimmer{background:linear-gradient(90deg,transparent,var(--ac-shimmer,rgba(200,168,78,0.12)),transparent);background-size:200% 100%;animation:shimmer 3s ease-in-out infinite;}
.breathe{animation:breathe 2.5s ease-in-out infinite;}
.spinner{width:18px;height:18px;border:2px solid var(--ac-spin-ring,rgba(200,168,78,0.2));border-top-color:var(--ac-spin-top,#c8a84e);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:middle;}
/* Picker wheels: snap to the centred row, and no scrollbar over them. */
/* user-select and the callout are off because the rows are text, and a finger
   held on text is a selection gesture to iOS: it raises the Copy / Look Up bar,
   takes the touch away from the scroller, and the wheel stops scrubbing under a
   thumb that is still moving. Every other control in the app already says this;
   the wheel was the one that did not. touch-action pins it to the one gesture it
   has, so nothing else can bid for the finger. */
.wheel-col{scrollbar-width:none;-ms-overflow-style:none;scroll-snap-type:y mandatory;overflow-y:auto;overscroll-behavior:contain;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:pan-y;}
.wheel-col::-webkit-scrollbar{display:none;}
/* Snapping brings every flick to a stop at the next row, which reads as the
   wheel fighting the finger on a list long enough to need flicking. Proximity
   was no better here: the rows are 28px apart, so wherever the momentum would
   land is near a snap point and proximity behaves like mandatory. So none at
   all — a flick runs its whole momentum, the way the nav sheet's book list
   does, and Wheel's settle glides onto the nearest row once it stops. The time
   picker keeps mandatory, where the travel is short and landing exactly on a
   number matters more than the spin. */
.wheel-glide{scroll-snap-type:none;}
/* The search field wears the same gold edge as the buttons beside it. The
   app's input:focus rule is !important, and this field is focused whenever
   it is on screen, so it needs the higher specificity to win. The colour
   comes from the element so it still follows the theme. */
.srch-field{border-color:var(--srch-bd)!important;box-shadow:none!important;}
/* Lit while it is being typed in, and back to the quiet edge once the search
   has gone and the field is blurred. */
.srch-field:focus{border-color:var(--srch-bd-on)!important;background:var(--srch-bg-on)!important;box-shadow:0 0 0 2px var(--srch-glow)!important;}
@media (hover:hover){.reading-verse:hover{background:var(--ac-verse-hover,rgba(200,168,78,0.05));border-radius:4px;}}
input:focus,select:focus,textarea:focus{border-color:var(--ac-input-bd,rgba(200,168,78,0.27))!important;box-shadow:0 0 0 2px var(--ac-input-sh,rgba(200,168,78,0.08));}
/* ── Mobile/tablet overrides (≤1199px) ── */
@media(max-width:1199px){
  .hide-mobile{display:none!important;}
  .full-mobile{width:100%!important;}
  .show-mobile{display:flex!important;}
  /* Scripture text: bigger, edge-to-edge */
  /* line-height now controlled by readLineHeight state */
  .read-area{padding-bottom:calc(80px + var(--plan-strip,0px))!important;scrollbar-width:none;-ms-overflow-style:none;}
  /* The eighty pixels are the bottom bar's seat. With the bar gone there is
     nothing to sit there, and leaving the gap would have meant sliding it away
     to reveal a strip of nothing — so the results take the space back. */
  .read-area.bar-away{padding-bottom:12px!important;}
  .read-area::-webkit-scrollbar{display:none;}
  .read-scrollbar{position:fixed;right:3px;width:3px;border-radius:2px;background:var(--ac-scrollbar-read,rgba(180,160,100,0.5));pointer-events:none;z-index:155;opacity:0;transition:opacity .4s ease;}
  .read-scrollbar.visible{opacity:1;transition:opacity .05s ease;}
  .sheet-scroll{scrollbar-width:none;-ms-overflow-style:none;}
  .sheet-scroll::-webkit-scrollbar{display:none;}
  .bottom-nav-safe{padding-bottom:calc(6px + env(safe-area-inset-bottom,0px))!important;}
  /* Tighter compare cards */
  .cmp-area{padding:10px 8px 20px!important;}
  /* Modal: full-screen sheet on mobile — drops from top */
  .modal-overlay{padding:0!important;align-items:flex-start!important;}
  .modal-panel{width:100%!important;max-height:92vh!important;border-radius:0 0 16px 16px!important;animation:modalInTop .28s cubic-bezier(0.32,0.72,0,1) both!important;}
  /* Top-sheet modals: drop from below nav bar, stop 50px from bottom */
  .modal-topsheet-panel{max-height:calc(100vh - var(--ts-h,0px) - 50px)!important;}
  /* Override modalInTop when closing — two-class specificity beats one-class !important */
  .modal-topsheet-panel.slide-down-sheet-out{animation:slideDownSheetOut .25s ease-in both!important;}
  /* Form rows: single column on mobile */
  .form-row{grid-template-columns:1fr!important;}
  /* Tighter modal padding on mobile */
  .modal-body{padding:16px!important;}
  .modal-subhead{padding:0 16px 14px!important;}
}
@media(max-width:1199px){
}
@media(min-width:1200px){
  .show-mobile{display:none!important;}
  .app-header{height:50px!important;padding:5px 10px 0!important;box-sizing:border-box!important;}
  .app-header-row{height:100%!important;}
  .read-scrollbar{position:fixed;right:3px;width:3px;border-radius:2px;background:var(--ac-scrollbar-read,rgba(180,160,100,0.5));pointer-events:none;z-index:155;opacity:0;transition:opacity .4s ease;visibility:hidden;}
}
@media print{.no-print{display:none!important;}body{background:#fff!important;color:#000!important;}.entry-card{border:1px solid #ccc!important;box-shadow:none!important;break-inside:avoid;margin-bottom:8px!important;}}
.cpicker-slider{-webkit-appearance:none;appearance:none;height:18px;border-radius:9px;outline:none;cursor:pointer;width:100%;border:none;display:block;}
.cpicker-slider::-webkit-slider-thumb{-webkit-appearance:none;width:28px;height:28px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.45),0 0 0 2px rgba(255,255,255,0.6);cursor:grab;margin-top:-5px;}
.cpicker-slider::-moz-range-thumb{width:28px;height:28px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);cursor:grab;border:none;}
.cpicker-slider::-webkit-slider-runnable-track{height:18px;border-radius:9px;}
.cpicker-slider::-moz-range-track{height:18px;border-radius:9px;}
`;


// ══════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════
const genId=()=>'id-'+Math.random().toString(36).slice(2,9)+Date.now().toString(36);
const clone=d=>JSON.parse(JSON.stringify(d));
const fmtDate=iso=>iso?new Date(iso).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'';
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function normRef(raw){if(!raw)return raw;const m=raw.trim().match(/^([\d]*\s*[a-zA-Z]+\.?)\s+(\d+.*)/);if(!m)return raw.trim();let book=m[1].replace(/\./g,'').trim();const key=book.toLowerCase().replace(/\s+/g,'');if(ABBREVS[key])book=ABBREVS[key];else book=book.charAt(0).toUpperCase()+book.slice(1);return book+' '+m[2];}
function parseRef(ref){if(!ref)return null;const m=ref.match(/^(.+?)\s+(\d+):(.+)$/);return m?{book:m[1].trim(),chapter:m[2],verse:m[3].trim()}:null;}
function parseRefDD(ref){if(!ref)return null;const m=ref.match(/^(.+?)\s+(\d+):(\d+)/);if(!m)return null;const b=BIBLE.find(x=>x.name.toLowerCase()===m[1].trim().toLowerCase());return b?{bookNum:b.n,chapter:parseInt(m[2]),verse:parseInt(m[3])}:null;}
// A search term as a pattern, the same for choosing verses, counting
// occurrences and highlighting them. Whole-word matching goes by letters in any
// script: \b counts only A-Z, so a word ending in an accented letter ("está")
// was never a whole word. Spaces in a phrase match any run of white space.
const SEARCH_ESC=/[.*+?^${}()|[\]\\]/g;
function searchRx(term,opts,global=true){
  let pat=String(term).trim().replace(SEARCH_ESC,'\\$&').replace(/\s+/g,'\\s+');
  if(opts&&opts.partial===false)pat=`(?<![\\p{L}\\p{N}])${pat}(?![\\p{L}\\p{N}])`;
  return new RegExp(pat,(global?'g':'')+(opts&&opts.caseSensitive?'':'i')+'u');
}
const searchPlain=t=>String(t||'').replace(/<[^>]+>/g,'');
function hl(text,q,opts){if(!text)return'';const plain=text.replace(/<[^>]+>/g,'');if(!q)return esc(plain);const cs=opts&&opts.caseSensitive;const words=(opts&&opts.mode&&opts.mode!=='phrase')?q.split(/\s+/).filter(Boolean):[q];
  // Every term is matched against the bare verse, and the marks are only built
  // at the end. This used to run the terms one after another over its own
  // output, so the second term could match inside the markup the first had just
  // inserted: with partial matching on, "a" hits the a in class="sch", splits
  // the tag down the middle, and the browser renders the wreckage as words.
  // That is where ark class="sch">Trainark> on screen came from.
  const hits=[];
  words.forEach(w=>{const rx=searchRx(w,opts);let m;while((m=rx.exec(plain))!==null){if(!m[0]){rx.lastIndex++;continue;}hits.push([m.index,m.index+m[0].length]);}});
  if(!hits.length)return esc(plain);
  // Overlaps merge into one mark rather than nesting — "the" and "he" both match
  // the same three letters, and two opening tags inside one another was the
  // other way this produced tags on screen.
  hits.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const merged=[];
  for(const h of hits){const last=merged[merged.length-1];if(last&&h[0]<=last[1])last[1]=Math.max(last[1],h[1]);else merged.push([h[0],h[1]]);}
  let out='',i=0;
  for(const[s,e]of merged){out+=esc(plain.slice(i,s))+'<mark class="sch">'+esc(plain.slice(s,e))+'</mark>';i=e;}
  return out+esc(plain.slice(i));}
function processRedLetter(text,enabled,isDark){if(!text)return'';if(enabled){const c=isDark?'#ef5350':'#c62828';return text.replace(/<red>/g,`<span style="color:${c}">`).replace(/<\/red>/g,'</span>');}return text.replace(/<red>|<\/red>/g,'');}

// ── Audio Bible helpers ──
const USFM_CODES=['GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL','MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV'];
const DEFAULT_FILESETS={kjv:'ENGKJVN2DA',rvg:null,p1602:null};
const OT_REG_NAMES=['Genesis_____','Exodus______','Leviticus___','Numbers_____','Deuteronomy_','Joshua______','Judges______','Ruth________','1Samuel_____','2Samuel_____','1Kings______','2Kings______','1Chronicles_','2Chronicles_','Ezra________','Nehemiah____','Esther______','Job_________','Psalms______','Proverbs____','Ecclesiastes','SongofSongs_','Isaiah______','Jeremiah____','Lamentations','Ezekiel_____','Daniel______','Hosea_______','Joel________','Amos________','Obadiah_____','Jonah_______','Micah_______','Nahum_______','Habakkuk____','Zephaniah___','Haggai______','Zechariah___','Malachi_____'];
const NT_REG_NAMES=['Matthew_____','Mark________','Luke________','John________','Acts________','Romans______','1Corinthians','2Corinthians','Galatians___','Ephesians___','Philippians_','Colossians__','1Thess______','2Thess______','1Timothy____','2Timothy____','Titus_______','Philemon____','Hebrews_____','James_______','1Peter______','2Peter______','1John_______','2John_______','3John_______','Jude________','Revelation__'];
function localAudioStem(bookNum,chapter){
  if(bookNum<=39){
    const a='A'+String(bookNum).padStart(2,'0');
    const isPsalms=bookNum===19;
    const chStr=isPsalms?String(chapter).padStart(3,'0'):String(chapter).padStart(2,'0');
    const sep=isPsalms?'__':'___';
    return{folder:'OT',stem:`${a}${sep}${chStr}_${OT_REG_NAMES[bookNum-1]}ENGKJVO1DA`};
  }
  const ntNum=bookNum-39;
  const b='B'+String(ntNum).padStart(2,'0');
  const ch2=String(chapter).padStart(2,'0');
  return{folder:'NT',stem:`${b}___${ch2}_${NT_REG_NAMES[ntNum-1]}ENGKJVN1DA`};
}
function localAudioUrl(bookNum,chapter){const{folder,stem}=localAudioStem(bookNum,chapter);return`${import.meta.env.BASE_URL}audio/${folder}/KJV%20Reg/${stem}.mp3`;}
function localTimestampUrl(bookNum,chapter){const{folder,stem}=localAudioStem(bookNum,chapter);return`${import.meta.env.BASE_URL}timestamps/${folder}/${stem}.json`;}
const FCBH_BASE='https://4.dbt.io/api';
async function fcbhCall(path,params={}){
  const key=localStorage.getItem('scrip:audio:fcbhKey')||'';
  if(!key)throw new Error('FCBH API key not configured');
  const u=new URL(FCBH_BASE+path);
  u.searchParams.set('v','4');
  u.searchParams.set('key',key);
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));
  const r=await fetch(u,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error('FCBH '+(r.status||'error'));
  return r.json();
}
async function fcbhGetChapterUrl(filesetId,bookUsfm,chapter){
  const d=await fcbhCall(`/bibles/filesets/${filesetId}/${bookUsfm}/${chapter}`);
  return d.data?.[0];
}
async function fcbhGetTimestamps(filesetId,bookUsfm,chapter){
  const d=await fcbhCall(`/timestamps/${filesetId}/${bookUsfm}/${chapter}`);
  if(!d.data)return null;
  return Object.fromEntries((d.data||[]).map(r=>{
    let ts=r.timestamp;
    if(typeof ts==='string'){const parts=ts.split(':');ts=parts.length===3?parseInt(parts[0])*3600+parseInt(parts[1])*60+parseInt(parts[2]):parseInt(parts[0])*60+parseInt(parts[1]);}
    return[r.verse_start,ts];
  }));
}

// Cross-references inside lexicon definitions are sometimes zero-padded ("H02022"),
// but strongs_lexicon keys them unpadded ("H2022"). Strip the padding so the links
// resolve and read consistently with the numbering shown everywhere else.
function normStrongsNum(n){
  const m=/^([HG])0*(\d+)$/.exec(n||'');
  return m?m[1]+m[2]:n;
}

// Module-level long-press state for Strong's word taps (only one word pressed at a time)
let _wlpTimer=null,_wlpFired=false,_wlpStartY=0,_wlpActive=false;

function buildStrongsVerse(text,mappings,onTap,T,dark,redLetter){
  // Build red/italic word position sets
  const redSet=new Set();
  const italicSet=new Set();
  let inRed=false,inItalic=false,rIdx=0;
  const rawTokens=text.split(/(\s+|<red>|<\/red>|<i>|<\/i>|<[^>]+>)/);
  for(const tok of rawTokens){
    if(tok==='<red>'){inRed=true;}
    else if(tok==='</red>'){inRed=false;}
    else if(tok==='<i>'){inItalic=true;}
    else if(tok==='</i>'){inItalic=false;}
    else if(/^</.test(tok)||/^\s*$/.test(tok)){}
    else{const wt=tok.replace(/^[.,;:!?'"()]+|[.,;:!?'"()]+$/g,'');if(wt){if(inRed)redSet.add(rIdx);if(inItalic)italicSet.add(rIdx);rIdx++;}}
  }
  const redColor=dark?'#ef5350':'#c62828';

  const cleanText=text.replace(/<red>|<\/red>/g,'').replace(/<[^>]+>/g,'');
  if(!mappings||!mappings.length)return React.createElement('span',null,cleanText);
  const words=cleanText.split(/(\s+)/);

  // Build posMap: word_pos → [{strongs_num, word_text}]
  // H853 (אֵת) is the Hebrew direct-object marker — it has no English translation.
  // SWORD attaches it to the adjacent English word (e.g. "and", "created"), producing
  // wrong underlines and wrong popup numbers. Filter it out here so those words become
  // plain fillers (or show H1254 when H1254+H853 share the same position).
  const posMap={};
  for(const m of mappings){
    if(m.strongs_num==='H853')continue;
    if(!posMap[m.word_pos])posMap[m.word_pos]=[];
    posMap[m.word_pos].push(m);
  }

  // Annotate each token
  const items=[];
  let wordIdx=0;
  for(let i=0;i<words.length;i++){
    const w=words[i];
    if(/^\s+$/.test(w)){items.push({kind:'space',text:w});continue;}
    const wordText=w.replace(/^[.,;:!?'"()]+|[.,;:!?'"()]+$/g,'');
    if(!wordText){items.push({kind:'punct',text:w});continue;} // punct-only: no wordIdx increment
    const mapped=posMap[wordIdx];
    let sNum=null;
    if(mapped&&mapped.length>0){
      const wl=wordText.toLowerCase();
      const best=mapped.find(m=>m.word_text&&m.word_text.toLowerCase()===wl);
      sNum=best?best.strongs_num:mapped[0].strongs_num;
    }
    const isRed=redLetter&&redSet.has(wordIdx);
    const isItalic=italicSet.has(wordIdx);
    const isContextRed=redLetter&&isItalic&&!isRed&&(redSet.has(wordIdx-1)||redSet.has(wordIdx+1));
    items.push({kind:'word',text:w,wordIdx,sNum,isRed:isRed||isContextRed,isItalic});
    wordIdx++;
  }

  // Phrase-prefix expansion: absorb immediately preceding untagged articles/prepositions
  // into the adjacent tagged word's span. This restores multi-word phrases like
  // "In the beginning" (H7225), "without form" (H8414), "the earth" (H776), etc.
  // Hebrew words often encode preposition+root as one word; KJV splits them across tokens.
  const ABSORB_BACK=new Set(['the','a','an','in','of','from','without','upon','unto','to','for','by','with','at','into','on']);
  for(let ii=0;ii<items.length;ii++){
    const it=items[ii];
    if(it.kind!=='word'||!it.sNum)continue;
    let scanned=0,k=ii-1;
    while(k>=0&&scanned<3){
      const prev=items[k];
      if(prev.kind==='space'){k--;continue;}
      if(prev.kind==='word'&&!prev.sNum){
        const pw=prev.text.replace(/^[.,;:!?'"()]+|[.,;:!?'"()]+$/g,'').toLowerCase();
        if(ABSORB_BACK.has(pw)){prev.sNum=it.sNum;scanned++;k--;}
        else break;
      }else break;
    }
  }

  // Group consecutive same-sNum words with bridging spaces into single phrase spans
  // so the dotted underline is unbroken across the whole phrase.
  const elems=[];
  let i=0;
  while(i<items.length){
    const item=items[i];
    if(item.kind==='space'||item.kind==='punct'){elems.push(item.text);i++;continue;}
    if(!item.sNum){
      const ws={...(item.isRed?{color:redColor}:{}),...(item.isItalic?{fontStyle:'italic'}:{})};
      elems.push((item.isRed||item.isItalic)?React.createElement('span',{key:i,style:ws},item.text):item.text);
      i++;continue;
    }
    // Collect all items in this phrase group
    const sNum=item.sNum;
    let j=i;
    while(j<items.length){
      const cur=items[j];
      if(cur.kind==='word'){
        if(cur.sNum===sNum){j++;}else break;
      }else if(cur.kind==='space'||cur.kind==='punct'){
        // Bridge this gap only if the next word continues the same phrase
        let nk=j+1;
        while(nk<items.length&&items[nk].kind!=='word')nk++;
        if(nk<items.length&&items[nk].sNum===sNum){j++;}else break;
      }else break;
    }
    const group=items.slice(i,j);
    const fw=group.find(x=>x.kind==='word');
    const ec=fw?.isRed?redColor:undefined;
    const ws={...(ec?{color:ec}:{}),...(fw?.isItalic?{fontStyle:'italic'}:{})};
    const groupText=group.map(x=>x.text).join('');
    elems.push(React.createElement('span',{
      key:i,
      onDoubleClick:e=>{e.stopPropagation();onTap(sNum,fw.text);},
      onTouchStart:e=>{_wlpActive=true;_wlpFired=false;_wlpStartY=e.touches[0].clientY;_wlpTimer=setTimeout(()=>{_wlpFired=true;_wlpTimer=null;onTap(sNum,fw.text);},500);},
      onTouchMove:e=>{if(Math.abs(e.touches[0].clientY-_wlpStartY)>8){if(_wlpTimer){clearTimeout(_wlpTimer);_wlpTimer=null;}}},
      onTouchEnd:e=>{if(_wlpTimer){clearTimeout(_wlpTimer);_wlpTimer=null;}if(_wlpFired){e.stopPropagation();}setTimeout(()=>{_wlpActive=false;},10);},
      style:{borderBottom:`1.5px dotted ${T.gM}`,cursor:'pointer',paddingBottom:1,WebkitUserSelect:'none',userSelect:'none',...ws}
    },groupText));
    i=j;
  }
  return React.createElement('span',null,...elems);
}

// ══════════════════════════════════════════════════════════
//  SUPABASE DB OPERATIONS
// ══════════════════════════════════════════════════════════
async function dbGetChapter(versionId,bookNum,chapter){
  // Local-first: read from IndexedDB if this version has been downloaded
  try{
    if(await idbIsDownloaded(versionId)){
      const local=await idbGetChapterLocal(versionId,bookNum,chapter);
      if(local.length>0)return local;
    }
  }catch(e){}
  // Network fallback
  const token=getToken();
  const {data}=await sbRpc('get_chapter_verses',{p_version_id:versionId,p_book_num:bookNum,p_chapter:chapter},token);
  if(Array.isArray(data)&&data.length>0)return data;
  const hdrs={...sbHeaders(token),'Range-Unit':'items','Range':'0-199'};
  const url=`${SUPA_URL}/rest/v1/bible_verses?select=verse%2Ctext&version_id=eq.${encodeURIComponent(versionId)}&book_num=eq.${bookNum}&chapter=eq.${chapter}&order=verse.asc&limit=200`;
  const r=await fetch(url,{headers:hdrs});
  const d=await r.json();
  return Array.isArray(d)?d:[];
}
async function dbGetStrongsForChapter(bookNum,chapter){
  try{if(await idbIsDownloaded('strongsmap')){const local=await idbGetStrongsMapChapter(bookNum,chapter);if(local)return local;}}catch{}
  const token=getToken();
  const {data}=await sbRpc('get_strongs_for_chapter',{p_book_num:bookNum,p_chapter:chapter},token);
  return Array.isArray(data)?data:[];
}
async function dbGetStrongsEntry(strongsNumber){
  try{if(await idbIsDownloaded('strongs')){const local=await idbGetStrongsEntryLocal(strongsNumber);if(local)return local;}}catch{}
  const token=getToken();
  const {data}=await sbRpc('get_strongs_entry',{p_strongs_number:strongsNumber},token);
  return data?.[0]||null;
}
async function dbSearchStrongs(query){
  try{if(await idbIsDownloaded('strongs')){return await idbSearchStrongsLocal(query);}}catch{}
  const token=getToken();
  const {data}=await sbRpc('search_strongs',{p_query:query},token);
  return Array.isArray(data)?data:[];
}
async function dbGetStrongsVerses(strongsNum){
  // Once the index is complete a missing record means the number genuinely has no
  // occurrences — which is what the server returns too — so don't fall back.
  try{if(await idbIsDownloaded('strongsocc')){return (await idbGetStrongsOccLocal(strongsNum))||[];}}catch{}
  const token=getToken();
  const {data}=await sbRpc('get_strongs_verses',{p_strongs_num:strongsNum},token);
  return Array.isArray(data)?data:[];
}
async function dbGetVerse(versionId,bookNum,chapter,verse){
  const token=getToken();
  const t=await sbFrom('bible_verses',token);
  const r=await t.select('verse,text',{version_id:versionId,book_num:bookNum,chapter,verse},{limit:1});
  return r.data?.[0]||null;
}
async function dbAutoFill(bookNum,chapter,verse,versionIds){
  const results={};
  await Promise.all(versionIds.map(async vid=>{
    const row=await dbGetVerse(vid,bookNum,chapter,verse);
    if(row?.text)results[vid]=row.text;
  }));
  return results;
}
async function dbLoadOrCreateProject(userId){
  const token=getToken();
  const t=await sbFrom('projects',token);
  const r=await t.select('*',{user_id:userId},{order:'created_at.asc',limit:1});
  if(r.error)throw new Error('project lookup failed');
  if(r.data?.length)return r.data[0];
  // Create project
  const ins=await t.insert({user_id:userId,title:'My Study'});
  const proj=ins.data?.[0];
  if(!proj)return null;
  // Seed default sections
  const sectT=await sbFrom('sections',token);
  const [s1,s2,s3]=await Promise.all([
    sectT.insert({project_id:proj.id,title:'English',description:'Use this section to compare English Bible versions',position:0}),
    sectT.insert({project_id:proj.id,title:'Spanish / Espanol',description:'Use this section to make notes on Spanish bible versions',position:1}),
    sectT.insert({project_id:proj.id,title:'Albanian / Shqip',description:'Use this section to make notes on Albanian Bible versions',position:2}),
  ]);
  // Seed default versions
  const pvT=await sbFrom('project_versions',token);
  await Promise.all([
    pvT.insert({project_id:proj.id,version_id:'kjv',label:'KJV',lang:'EN',is_ref:true,position:0}),
    pvT.insert({project_id:proj.id,version_id:'rvg',label:'RVG',lang:'ES',is_ref:false,position:1}),
    pvT.insert({project_id:proj.id,version_id:'p1602',label:'1602P',lang:'ES',is_ref:false,position:2}),
  ]);
  // Seed example entry in Spanish section
  const sectEsId=s2.data?.[0]?.id;
  if(sectEsId){
    const entT=await sbFrom('entries',token);
    const entIns=await entT.insert({project_id:proj.id,section_id:sectEsId,book_num:1,chapter:1,verse_start:1,verse_end:1,issue_type:'manuscript',notes:'Some versions translate Genesis 1:1 "heaven" as plural. This is not accurate as God had only created one heaven at this point.',position:0});
    const entId=entIns.data?.[0]?.id;
    if(entId){
      const evT=await sbFrom('entry_versions',token);
      await Promise.all([
        evT.insert({entry_id:entId,version_id:'kjv',text:'In the beginning God created the heaven and the earth.',status:'reference'}),
        evT.insert({entry_id:entId,version_id:'rvg',text:'En el principio creó Dios el cielo y la tierra.',status:'faithful'}),
        evT.insert({entry_id:entId,version_id:'p1602',text:'EN el principio creó Dios el cielo y la tierra.',status:'faithful'}),
      ]);
    }
  }
  return proj;
}
async function dbLoadProject(projectId){
  const token=getToken();
  const [secR,entR,pvR]=await Promise.all([
    sbFrom('sections',token).then(t=>t.select('*',{project_id:projectId},{order:'position.asc'})),
    sbFrom('entries',token).then(t=>t.select('*',{project_id:projectId},{order:'position.asc,created_at.asc'})),
    sbFrom('project_versions',token).then(t=>t.select('*',{project_id:projectId},{order:'position.asc'})),
  ]);
  const entries=entR.data||[];
  // Load all entry_versions for this project's entries
  let evMap={};
  if(entries.length){
    const evAll=await fetch(
      `${SUPA_URL}/rest/v1/entry_versions?select=*`,
      {headers:sbHeaders(token)}
    ).then(r=>r.json());
    const entryIds=new Set(entries.map(e=>e.id));
    for(const ev of (Array.isArray(evAll)?evAll:[])){
      if(!entryIds.has(ev.entry_id))continue;
      if(!evMap[ev.entry_id])evMap[ev.entry_id]={};
      evMap[ev.entry_id][ev.version_id]={text:ev.text,status:ev.status};
    }
  }
  // Load user-owned private versions so they reappear on re-login
  let userVers=[];
  try{
    const uvAll=await fetch(`${SUPA_URL}/rest/v1/bible_versions?is_public=eq.false&select=*`,{headers:sbHeaders(token)}).then(r=>r.json());
    if(Array.isArray(uvAll))userVers=uvAll;
  }catch(e){}
  // Merge project_versions with any user-owned versions not yet listed
  const pvData=pvR.data||[];
  const pvIds=new Set(pvData.map(v=>v.version_id));
  const extraVers=userVers.filter(v=>!pvIds.has(v.id)).map((v,i)=>({version_id:v.id,label:v.label,lang:v.lang,is_ref:false,position:pvData.length+i}));
  return{
    sections:secR.data||[],
    entries:entries.map(e=>{
      const bk=BIBLE.find(b=>b.n===e.book_num);
      return{...e,sectionId:e.section_id||null,reference:bk&&e.chapter&&e.verse_start?`${bk.name} ${e.chapter}:${e.verse_start}`:'',versions:evMap[e.id]||{}};
    }),
    versions:(()=>{const seen=new Set();return[...pvData,...extraVers].filter(v=>{if(seen.has(v.version_id))return false;seen.add(v.version_id);return true;}).map(v=>({id:v.version_id,label:v.label,lang:v.lang,isRef:v.is_ref}));})(),
  };
}
async function dbSaveEntry(entry,projectId){
  const token=getToken();
  const parsed=parseRefDD(entry.reference);
  const row={project_id:projectId,section_id:entry.sectionId||null,book_num:parsed?.bookNum||null,chapter:parsed?.chapter||null,verse_start:parsed?.verse||null,verse_end:parsed?.verse||null,issue_label:entry.issueLabel||null,issue_type:entry.issueType||null,notes:entry.notes||null,greek_hebrew:entry.greekHebrew||null,source_refs:entry.sourceRefs||null,position:entry.position||0};
  const t=await sbFrom('entries',token);
  let id=entry.id;
  if(entry._isNew){const r=await t.insert(row);id=r.data?.[0]?.id;if(!id)throw new Error('Insert failed:'+JSON.stringify(r.error));}
  else{await t.update(row,{id:entry.id});}
  // Replace entry_versions
  const evT=await sbFrom('entry_versions',token);
  await evT.delete({entry_id:id});
  const evRows=Object.entries(entry.versions||{}).map(([vid,vd])=>({entry_id:id,version_id:vid,text:vd.text||'',status:vd.status||'faithful'}));
  if(evRows.length){const evT2=await sbFrom('entry_versions',token);await evT2.insert(evRows);}
  return id;
}
async function dbDeleteEntry(id){const token=getToken();const t=await sbFrom('entries',token);await t.delete({id});}
async function dbSaveSection(sec,projectId){
  const token=getToken();const t=await sbFrom('sections',token);
  if(sec._isNew||!sec.id){const r=await t.insert({project_id:projectId,title:sec.title,description:sec.description||null,position:sec.position||0});return r.data?.[0]?.id;}
  else{await t.update({title:sec.title,description:sec.description||null},{id:sec.id});return sec.id;}
}
async function dbDeleteSection(id){const token=getToken();const t=await sbFrom('sections',token);await t.delete({id});}
async function dbUpdateSectionPosition(id,position){const token=getToken();const t=await sbFrom('sections',token);await t.update({position},{id});}
async function dbSaveVersions(projectId,versions){
  const token=getToken();const t=await sbFrom('project_versions',token);
  await t.delete({project_id:projectId});
  if(versions.length){const t2=await sbFrom('project_versions',token);await t2.insert(versions.map((v,i)=>({project_id:projectId,version_id:v.id,label:v.label,lang:v.lang||'EN',is_ref:!!v.isRef,position:i})));}
}
async function dbLoadBookmarks(userId){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.select('*',{user_id:userId},{order:'created_at.desc'});if(r.error)throw new Error('bookmarks load failed');return r.data||[];}
async function dbAddBookmark(userId,{versionId,bookNum,chapter,verse,label,categoryId,note}){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.insert({user_id:userId,version_id:versionId,book_num:bookNum,chapter,verse:verse||null,label:label||null,category_id:categoryId||null,note:note||null});return r.data?.[0];}
async function dbUpdateBookmark(id,{note,categoryId,label}){const token=getToken();const t=await sbFrom('bookmarks',token);const patch={};if(note!==undefined)patch.note=note||null;if(categoryId!==undefined)patch.category_id=categoryId||null;if(label!==undefined)patch.label=label||null;await t.update(patch,{id});}
async function dbDeleteBookmark(id){const token=getToken();const t=await sbFrom('bookmarks',token);await t.delete({id});}
async function dbLoadCategories(userId){const token=getToken();const t=await sbFrom('bookmark_categories',token);const r=await t.select('*',{user_id:userId},{order:'sort_order.asc,created_at.asc'});if(r.error)throw new Error('categories load failed');return r.data||[];}
async function dbAddCategory(userId,{name,color}){const token=getToken();const t=await sbFrom('bookmark_categories',token);const r=await t.insert({user_id:userId,name,color:color||'#62c484'});return r.data?.[0];}
async function dbUpdateCategory(id,{name,color}){const token=getToken();const t=await sbFrom('bookmark_categories',token);const patch={};if(name!==undefined)patch.name=name;if(color!==undefined)patch.color=color;await t.update(patch,{id});}
async function dbDeleteCategory(id){const token=getToken();const t=await sbFrom('bookmark_categories',token);await t.delete({id});}
// ── Highlights ──
// One colour per verse, per version. Bands are translucent so the words, the
// Strong's underlines and red letter all read through; each has a dark and a
// light strength, and none sits near red, which would fight red letter.
const HL_COLORS=[
  {key:'yellow',label:'Yellow',dot:'#e4c448',dark:'rgba(228,196,72,0.20)',light:'rgba(240,196,40,0.26)'},
  {key:'green', label:'Green', dot:'#62c484',dark:'rgba(98,196,132,0.18)',light:'rgba(70,180,110,0.19)'},
  {key:'blue',  label:'Blue',  dot:'#6aaaeb',dark:'rgba(106,170,235,0.19)',light:'rgba(80,150,230,0.18)'},
  {key:'purple',label:'Purple',dot:'#aa82dc',dark:'rgba(170,130,220,0.20)',light:'rgba(150,110,215,0.18)'},
  {key:'orange',label:'Orange',dot:'#eb9650',dark:'rgba(235,150,80,0.19)',light:'rgba(240,145,60,0.21)'},
];
const hlByKey=Object.fromEntries(HL_COLORS.map(c=>[c.key,c]));
const HL_URL=`${SUPA_URL}/rest/v1/highlights`;
// A page at a time: the server returns at most a thousand rows per request.
async function dbLoadHighlights(userId){
  const token=getToken(),out=[];
  for(let from=0;;from+=1000){
    const r=await sbFetch(`${HL_URL}?select=version_id,book_num,chapter,verse,color,created_at&user_id=eq.${userId}&order=book_num.asc,chapter.asc,verse.asc&limit=1000&offset=${from}`,{headers:sbHeaders(token),signal:sbSignal()},token);
    const{data,error}=await sbBody(r);
    if(error)throw new Error('highlights load failed');
    out.push(...data);
    if(data.length<1000)return out;
  }
}
// Every selected verse in one request. A verse that already has a colour takes
// the new one: the table allows one colour per verse, per version.
async function dbSetHighlights(userId,versionId,bookNum,chapter,verses,color){
  const token=getToken(),now=new Date().toISOString();
  const rows=verses.map(verse=>({user_id:userId,version_id:versionId,book_num:bookNum,chapter,verse,color,updated_at:now}));
  const r=await sbFetch(`${HL_URL}?on_conflict=user_id,version_id,book_num,chapter,verse`,{method:'POST',headers:{...sbHeaders(token),'Prefer':'return=minimal,resolution=merge-duplicates'},body:JSON.stringify(rows),signal:sbSignal()},token);
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
}
async function dbRemoveHighlights(userId,versionId,bookNum,chapter,verses){
  const token=getToken();
  const r=await sbFetch(`${HL_URL}?user_id=eq.${userId}&version_id=eq.${encodeURIComponent(versionId)}&book_num=eq.${bookNum}&chapter=eq.${chapter}&verse=in.(${verses.join(',')})`,{method:'DELETE',headers:sbHeaders(token),signal:sbSignal()},token);
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
}
async function dbLoadRecents(userId){const token=getToken();const t=await sbFrom('recent_passages',token);const r=await t.select('*',{user_id:userId},{order:'visited_at.desc',limit:20});if(r.error)throw new Error('recents load failed');return r.data||[];}
async function dbRecordRecent(userId,versionId,bookNum,chapter){const token=getToken();await sbRpc('upsert_recent_passage',{p_user_id:userId,p_version_id:versionId,p_book_num:bookNum,p_chapter:chapter},token);}


// ══════════════════════════════════════════════════════════
//  UI ATOMS
// ══════════════════════════════════════════════════════════
function Lbl({c,req,T}){return <div style={{fontFamily:FS,fontSize:U(11),letterSpacing:'0.14em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:500}}>{c}{req&&<span style={{color:'#d46868',marginLeft:4}}>*</span>}</div>;}
function OrnRule({T}){return(<div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><div style={{flex:1,height:1,background:T.accentLine}}/><span style={{color:T.gD,fontSize:UL(8),lineHeight:1}}>✦</span><div style={{flex:1,height:1,background:T.accentLine}}/></div>);}
function Inp({val,set,ph,T,type}){return <input className="s-btn" type={type||'text'} value={val} onChange={e=>set(e.target.value)} placeholder={ph||''} style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 13px',outline:'none'}}/>;}
function Sel({val,set,children,T,sm,dis}){return <select className="s-btn" value={val} onChange={e=>set(e.target.value)} disabled={dis} style={{width:sm?'auto':'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:val?T.mut:T.dim,fontFamily:FB,fontSize:sm?14:16,padding:sm?'5px 10px':'9px 13px',cursor:'pointer',opacity:dis?.4:1,outline:'none'}}>{children}</select>;}
function TA({val,set,ph,T,rows}){return <textarea className="s-btn" value={val} onChange={e=>set(e.target.value)} placeholder={ph||''} rows={rows||3} style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'9px 13px',resize:'vertical',lineHeight:1.7,outline:'none'}}/>;}
function GhostBtn({ch,onClick,active,T,title}){return <button className="s-btn s-ghost" onClick={onClick} title={title} style={{background:active?T.gF:'transparent',border:`1px solid ${active?T.gD:'transparent'}`,borderRadius:6,color:active?T.gT:T.dim,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.08em',padding:'5px 11px',whiteSpace:'nowrap',fontWeight:active?600:400,cursor:'pointer',transition:'all .15s'}}>{ch}</button>;}
function TBtn({ch,onClick,active,primary,T}){const p=primary||active;return <button className="s-btn s-tbtn" onClick={onClick} style={{background:p?T.gF:'transparent',border:`1px solid ${p?T.gD:T.bd}`,borderRadius:6,color:p?T.gT:T.dim,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.1em',textTransform:'uppercase',padding:'7px 14px',whiteSpace:'nowrap',fontWeight:500}}>{ch}</button>;}
function IBtn({ch,onClick,danger,T,title,disabled}){return <button className={`s-btn${danger?' s-danger':' s-ghost'}`} onClick={onClick} title={title} disabled={disabled} style={{background:danger?T.red:'transparent',border:`1px solid ${danger?T.redTxt+'33':T.bd+'40'}`,borderRadius:5,color:danger?T.redTxt:T.dim,padding:'4px 9px',fontSize:U(13),fontFamily:FB,lineHeight:1,fontWeight:500,opacity:disabled?.3:1,cursor:disabled?'default':'pointer'}}>{ch}</button>;}
function PBtn({ch,onClick,T,sm,danger,disabled}){const bg=danger?T.red:T.gF;const bc=danger?T.redTxt+'55':T.gD;const tc=danger?T.redTxt:T.gT;return <button className="s-btn" onClick={onClick} disabled={disabled} style={{background:bg,border:`1px solid ${bc}`,borderRadius:6,color:tc,fontFamily:FS,fontSize:sm?9:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:sm?'6px 13px':'8px 18px',whiteSpace:'nowrap',fontWeight:600,opacity:disabled?.45:1,cursor:disabled?'default':'pointer'}}>{ch}</button>;}
function SBtn({ch,onClick,T}){return <button className="s-btn s-ghost" onClick={onClick} style={{background:'transparent',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.1em',textTransform:'uppercase',padding:'8px 18px',whiteSpace:'nowrap',fontWeight:500}}>{ch}</button>;}
function Badge({type,label,dark}){const bc=(dark?BD:BL)[type]||(dark?BD.other:BL.other);return <span style={{fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.1em',textTransform:'uppercase',padding:'3px 9px',borderRadius:4,border:`1px solid ${bc.bd}`,background:bc.bg,color:bc.txt,whiteSpace:'nowrap',flexShrink:0,fontWeight:500}}>{label}</span>;}
// Shared close / back control. Several of these were bare glyphs with little or no
// padding — a ~18px target against Apple's 44pt minimum, and with border:none they
// did not read as buttons. Fixed 40px box with a visible border fixes both.
function NavIconBtn({ch,onClick,T,title,label,size=40}){
  return <button type="button" className="s-btn s-ghost" onClick={onClick} title={title||label} aria-label={title||label}
    style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:9,color:T.gT,
      width:label?'auto':size,height:size,minWidth:size,padding:label?'0 13px':0,
      display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5,
      fontFamily:label?FS:FB,fontSize:label?12:17,fontWeight:600,letterSpacing:label?'0.06em':undefined,
      lineHeight:1,cursor:'pointer',flexShrink:0,boxSizing:'border-box'}}>{ch}{label}</button>;
}
function Spinner(){return <span className="spinner"/>;}
// One triangle, rotated when open, so the two states cannot differ in size.
// These were text glyphs before — and no reading font contains them, so the OS
// substituted its own, in which the up and down arrows are not a matched pair.
// The mismatch therefore varied by platform and was worst on device.
function Caret({open,size=12}){
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true"
      style={{display:'block',flexShrink:0,transition:'transform .2s',transform:open?'rotate(180deg)':'none'}}>
      <path d="M2.5 4.5 L6 8.5 L9.5 4.5 Z" fill="currentColor"/>
    </svg>
  );
}
function SheetBackBtn({onClick,T,title='Back'}){
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
      ←
    </button>
  );
}
function PlayMark({size=13}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>;
}
function PwEye({shown}){
  const p={width:17,height:17,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'};
  return shown
    ? <svg {...p}><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.5 5.2A9.6 9.6 0 0112 5c5.2 0 9 4.7 9 7 0 1-.7 2.3-1.9 3.5M6.2 6.8C4 8.3 3 10.3 3 12c0 2.3 3.8 7 9 7 1.1 0 2.2-.2 3.1-.6"/></svg>
    : <svg {...p}><path d="M3 12s3.8-7 9-7 9 7 9 7-3.8 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="2.7"/></svg>;
}

// Dragging a sheet ran through React state, re-rendering the whole panel on
// every touchmove — on the Strong's panel that is its entire usage list, which
// is why it dragged heavily. The transform goes straight to the node now and
// React never sees it.
//
// Two things have to be overridden to move a panel at all. Every open and close
// here is a CSS animation with fill:both, and a finished animation outranks an
// inline transform — which is why the sheets' drag handlers have always run
// without the panel following. And one of those rules is !important, so the
// override has to be important too; an important inline declaration outranks
// any author rule, whatever its specificity.
//
// dir is 1 for a panel that leaves downwards, -1 for one that leaves upwards.
function useSheetDrag(dir,onDismiss,onStart,onSettled){
  const ref=React.useRef(null);
  const startY=React.useRef(null);
  const dist=React.useRef(0);
  const t0=React.useRef(0);
  const settle=React.useRef(0);
  function put(y,ease){
    const el=ref.current;if(!el)return;
    el.style.setProperty('animation','none','important');
    el.style.setProperty('transition',ease?('transform '+ease):'none','important');
    el.style.setProperty('transform','translateY('+y+')','important');
  }
  function release(){
    // Hand the panel back to its stylesheet once it has settled, so a later
    // close still animates instead of being pinned by animation:none.
    const tok=++settle.current;
    setTimeout(()=>{
      if(settle.current!==tok)return;
      const el=ref.current;
      if(el){
        el.style.removeProperty('transform');
        el.style.removeProperty('transition');
        el.style.removeProperty('animation');
      }
      if(onSettled)onSettled();
    },220);
  }
  return{
    ref,
    handlers:{
      onTouchStart(e){
        settle.current++; // cancel any pending hand-back
        startY.current=e.touches[0].clientY;t0.current=Date.now();dist.current=0;
        if(onStart)onStart();
      },
      onTouchMove(e){
        if(startY.current===null)return;
        const raw=e.touches[0].clientY-startY.current;
        const y=dir>0?Math.max(0,raw):Math.min(0,raw);
        dist.current=Math.abs(y);
        put(y+'px');
      },
      onTouchEnd(){
        if(startY.current===null)return;
        const d=dist.current,v=d/Math.max(1,Date.now()-t0.current);
        startY.current=null;dist.current=0;
        // A tap on the handle is not a drag: leave the panel entirely alone, or
        // an opening sheet would be snapped to its end state mid-animation.
        if(d===0){if(onSettled)onSettled();return;}
        if(d>SHEET_DISMISS_PX||(v>SHEET_FLICK_V&&d>SHEET_FLICK_PX)){
          // Carry it the rest of the way from where the finger left off, rather
          // than handing back to a close animation that starts at the top.
          put(dir>0?'110%':'-110%','.24s cubic-bezier(0.4,0,1,1)');
          onDismiss();
          return;
        }
        put('0px','.2s ease-out');
        release();
      },
    },
  };
}

// The iOS wheel is unmistakably iOS, and sat oddly in a page of bordered serif
// controls. This spins like one but in the app's own hand: Cinzel on the app's
// own ground, the centred row picked out by a gold band, and the rows above and
// below fading out the way the reading plan's list does.
//
// Snapping is left to CSS — scroll-snap does the physics far better than touch
// handlers would — so all this has to do is read back which row it settled on.
const WHEEL_ITEM=36;
const WHEEL_ROWS=5; // odd, so one row is the middle
// How long the wheel has to be still before it counts as stopped.
const SETTLE_MS=70;
// The sizes below are the reminder time's, kept as defaults so that picker is
// untouched; the book wheel passes its own to sit small under the search bar.
function Wheel({items,value,onChange,onCentre,render,T,width,itemH=WHEEL_ITEM,rows=WHEEL_ROWS,font=UL(16),fontSel=UL(19),fadeTop,fadeBot,band=true,glide,dimColor,dimOp=0.55}){
  const ref=React.useRef(null);
  const settle=React.useRef(null);
  // What was last handed to onChange. It cannot be read off value any more:
  // onCentre moves value with the wheel, so by the time this settles the two are
  // already equal and the jump would never go out.
  const committed=React.useRef(value);
  const landRef=React.useRef(null);
  const pad=itemH*((rows-1)/2);
  React.useEffect(()=>{
    // Start on the current value. Assigning scrollTop rather than scrolling to
    // it, so it is simply already there rather than animating on open.
    const el=ref.current,i=items.indexOf(value);
    if(el&&i>=0)el.scrollTop=i*itemH;
  },[]);
  // Stillness is the whole of the wait now — what follows is a scroll assignment
  // and a render, some twenty milliseconds — where it was set long back when
  // firing early cost seconds. Four frames is still well clear of the gap
  // between two scroll events in a live flick.
  //
  // It runs the current land rather than the one that existed when the timer was
  // set: the document listeners below are installed once, and a settle armed
  // from them would otherwise be answering with the first render's books.
  function arm(){
    if(settle.current)clearTimeout(settle.current);
    settle.current=setTimeout(()=>{settle.current=null;if(landRef.current)landRef.current();},SETTLE_MS);
  }
  function onScroll(){
    const el=ref.current;
    // What is under the middle right now, told straight away. Settling is a
    // separate thing and deliberately will not happen under a finger — but the
    // name and the highlight are just a readout of where the wheel is, and
    // holding those back until the finger lifts left a spinning wheel with no
    // row lit and a stale name above it. Nothing here commits anything.
    if(el&&onCentre){
      const c=Math.max(0,Math.min(items.length-1,Math.round(el.scrollTop/itemH)));
      if(items[c]!==value)onCentre(items[c]);
    }
    arm();
  }
  // Stillness is the whole rule: seventy milliseconds without the wheel moving
  // and it settles, whether or not a finger is on the glass. Brock asked for
  // this outright, after a long run of attempts to hold the settle off until
  // the hand was gone — a touchstart swallowed by a coasting scroller, a
  // touchend arriving mid-gesture, the wheel’s own deceleration read as a
  // catch. Each worked for the case it was written for and surprised him
  // somewhere else, and a wheel that behaves the same way every time is worth
  // more than one that is right about intent and unpredictable about it.
  //
  // So pausing mid-scrub settles, and jumps. That is the trade, and this is now
  // the one path here with no branch that can decline to fire.
  function land(){
    const el=ref.current;
    if(!el)return;
    const i=Math.max(0,Math.min(items.length-1,Math.round(el.scrollTop/itemH)));
    const target=i*itemH;
    // Unsnapped, the wheel comes to rest wherever the flick left it, so
    // squaring up onto the row is this rather than the compositor's — and it
    // is assigned, not animated. A programmatic smooth scroll runs on the main
    // thread, which onChange is about to fill with the jump's render, and the
    // fourteen pixels it had to travel were taking two seconds to cross on a
    // long result set. Assigned, the row is under the middle before the render
    // starts and the jump goes out in the same pass. Half a row at rest is not
    // a movement anyone follows; two seconds of creep is.
    if(Math.abs(el.scrollTop-target)>1)el.scrollTop=target;
    if(items[i]!==committed.current){committed.current=items[i];onChange(items[i]);}
  }
  landRef.current=land;
  return (
    <div style={{position:'relative',flex:width||1,minWidth:0}}>
      {/* Behind the numbers, so it marks the middle without painting over it.
          "rules" is the same bracket without the fill, for the book wheel: the
          fill under a name read as a grey slab, but with nothing there at all
          you could not see which row the spin was on until it stopped and the
          row took the gold. The two hairlines say where the middle is while the
          names are still moving through it. */}
      {band&&<div aria-hidden style={{position:'absolute',zIndex:0,left:0,right:0,top:pad,height:itemH,borderTop:`1px solid ${T.gD}`,borderBottom:`1px solid ${T.gD}`,background:band==='rules'?'none':T.gF,pointerEvents:'none'}}/>}
      <div ref={ref} className={"wheel-col"+(glide?' wheel-glide':'')} onScroll={onScroll}
        style={{position:'relative',zIndex:1,height:itemH*rows}}>
        {/* Spacers rather than padding: padding on a scroll container is part of
            its own box, which would have made the column twice as tall as it
            looks. These simply let the first and last rows reach the middle. */}
        <div style={{height:pad}}/>
        {items.map(it=>(
          <div key={it} onClick={()=>{const el=ref.current;if(el)el.scrollTo({top:items.indexOf(it)*itemH,behavior:'smooth'});}}
            style={{height:itemH,scrollSnapAlign:'center',display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
              fontFamily:FS,fontSize:it===value?fontSel:font,fontWeight:it===value?600:400,
              color:it===value?T.gT:(dimColor||T.dim),opacity:it===value?1:dimOp,transition:'color .12s, opacity .12s'}}>
            {render?render(it):it}
          </div>
        ))}
        <div style={{height:pad}}/>
      </div>
      {/* Over the numbers, fading the rows either side of the middle out. */}
      <div aria-hidden style={{position:'absolute',zIndex:2,left:0,right:0,top:0,height:pad,background:fadeTop||`linear-gradient(${T.bgCard},${T.bgCard}00)`,pointerEvents:'none'}}/>
      <div aria-hidden style={{position:'absolute',zIndex:2,left:0,right:0,bottom:0,height:pad,background:fadeBot||`linear-gradient(${T.bgCard}00,${T.bgCard})`,pointerEvents:'none'}}/>
    </div>
  );
}
const WHEEL_HOURS=Array.from({length:12},(_,i)=>i+1);
const WHEEL_MINUTES=Array.from({length:60},(_,i)=>i);
function TimePicker({value,onSet,onCancel,T}){
  const[h24,m0]=String(value||PLAN_REMIND_TIME).split(':').map(Number);
  const[h,setH]=React.useState(()=>((h24||0)%12)||12);
  const[m,setM]=React.useState(()=>m0||0);
  const[ap,setAp]=React.useState(()=>(h24||0)>=12?'PM':'AM');
  // 12 AM is hour 0 and 12 PM is hour 12, which is the one case the obvious
  // arithmetic gets wrong.
  const asValue=()=>String((h%12)+(ap==='PM'?12:0)).padStart(2,'0')+':'+String(m).padStart(2,'0');
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onCancel();}}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',backdropFilter:'blur(4px)',WebkitBackdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:320,padding:20}}>
      <div style={{background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:14,width:'min(92vw,330px)',boxShadow:'0 32px 80px rgba(0,0,0,0.7)',overflow:'hidden'}}>
        <div style={{height:3,background:T.accentLine}}/>
        <div style={{padding:'16px 18px 18px'}}>
          <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.14em',textTransform:'uppercase',color:T.gM,textAlign:'center',marginBottom:10}}>Daily reminder</div>
          <div style={{display:'flex',alignItems:'stretch',gap:4,marginBottom:16}}>
            <Wheel items={WHEEL_HOURS} value={h} onChange={setH} T={T}/>
            <Wheel items={WHEEL_MINUTES} value={m} onChange={setM} T={T} render={n=>String(n).padStart(2,'0')}/>
            <Wheel items={['AM','PM']} value={ap} onChange={setAp} T={T}/>
          </div>
          <div style={{display:'flex',gap:10}}>
            <button type="button" onClick={onCancel}
              style={{flex:1,background:'none',border:`1px solid ${T.bd}`,borderRadius:8,color:T.gM,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'11px 0',cursor:'pointer'}}>Cancel</button>
            <button type="button" onClick={()=>onSet(asValue())}
              style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',fontWeight:600,padding:'11px 0',cursor:'pointer'}}>Set</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The search bar's book name opens this. It replaced a rail of three-letter
// stubs down the right edge of the results, which was unreadable at 7.5px, only
// appeared if you happened to scroll, and sat over the very results it existed
// to move through. The wheel is the reminder time's, so this is a gesture the
// app already teaches rather than a second one.
function BookWheel({books,value,lang,onJump,onClose,box,T}){
  // Wheel seeds its scroll position from `value` once, at mount, so the running
  // selection is held here. It is also what the header above the wheel reads, so
  // the name up there is the wheel's own answer rather than a second source.
  const[pick,setPick]=React.useState(()=>books.includes(value)?value:books[0]);
  const ROW=28;
  // As many rows as there are books to show, to a point: three for a result set
  // that only touches three, seven once there are enough to be worth spinning
  // through. Odd, because a centred selection needs a middle row.
  const rows=books.length>=7?7:books.length>=5?5:3;
  return (
    <div data-bookwheel style={{position:'fixed',zIndex:196, /* above the bar's 195, below the nav's 200: it stands where the bar's own label is, and a backdrop-filtered bar paints its blur over anything behind it */
      // Two pixels clear of the field and the filter chevron above it, not
      // touching them: the label's box overhangs the row above by one, so its
      // own top plus three is the field's bottom plus two.
      top:box.top+3,left:box.left-7,width:75,
      background:'var(--ac-glass-bg)',border:`1px solid ${T.gD}55`,borderRadius:8,
      backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',
      boxShadow:'0 4px 14px rgba(0,0,0,0.22)',padding:'0 6px 4px',
      // slideDown scales as well as slides, and from the middle the panel swells
      // open instead of dropping. The top edge is what it hangs from — and now
      // what it is anchored to — so that is where it should unfurl from.
      transformOrigin:'50% 0',animation:'slideDown .2s cubic-bezier(0.32,0.72,0,1) both'}}>
      {/* The name the bar was showing, kept where it was and in its own type, so
          opening the wheel does not take it away. It is not part of the wheel —
          the rule under it says so — but it reads the wheel's selection, so
          spinning changes it. Tapping it closes, the way tapping the label did. */}
      <div onClick={onClose} style={{height:ROW,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
        fontFamily:FS,fontSize:U(11),fontWeight:600,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',
        overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
        {shortBook(bookName(BIBLE.find(x=>x.n===pick),lang))}
      </div>
      <div aria-hidden style={{height:1,background:`${T.gD}55`,marginBottom:2}}/>
      <Wheel items={books} value={pick} T={T} band="rules" glide itemH={ROW} rows={rows} font={UL(12)} fontSel={UL(13)}
        // No fades: they are square-cornered rectangles, and inside a panel with
        // rounded corners they read as dark blocks with their own edges.
        fadeTop="none" fadeBot="none"
        // The time picker's unselected numbers are T.dim at 55%, which is quiet
        // enough on its opaque card. This panel has no fill of its own — the
        // page's verse text is blurred behind the names — and at that weight
        // they were barely there. The muted body tone reads without competing
        // with the middle row, which is gold, bolder and a point larger.
        dimColor={T.mut} dimOp={0.85}
        onChange={onJump} onCentre={setPick}
        render={bn=><span style={{display:'block',maxWidth:'100%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{shortBook(bookName(BIBLE.find(x=>x.n===bn),lang))}</span>}/>
    </div>
  );
}

// The pill is 4px in a strip not much taller, which is a small thing to aim a
// thumb at. This reaches further out from the strip without taking any layout
// space — making the strip itself taller is what pushed everyone's buttons
// around last time. It goes on the side the panel's own edge is not, since
// anything past that edge is clipped away.
const GRIP_REACH=18;
function GripReach({up}){
  return <div aria-hidden style={{position:'absolute',left:0,right:0,height:GRIP_REACH,zIndex:1,touchAction:'none',...(up?{bottom:'100%'}:{top:'100%'})}}/>;
}

// Softens the top and bottom edges of a scrolling list so it reads as
// scrollable. Each edge only shows when there is something past it. `key` is
// whatever changes the content without scrolling it — the nav sheet swapping
// between books, chapters and verses, for instance.
function useEdgeFade(enabled,T,key){
  const ref=React.useRef(null);
  const[top,setTop]=React.useState(false);
  const[bot,setBot]=React.useState(false);
  React.useEffect(()=>{
    if(!enabled)return;
    const el=ref.current;
    if(!el)return;
    const update=()=>{
      const t=el.scrollTop>8,b=el.scrollTop+el.clientHeight<el.scrollHeight-8;
      setTop(p=>p===t?p:t);setBot(p=>p===b?p:b);
    };
    update();
    el.addEventListener('scroll',update,{passive:true});
    const t0=setTimeout(update,80);   // a body that scrolls itself on open
    return()=>{el.removeEventListener('scroll',update);clearTimeout(t0);};
  },[enabled,key]);
  // A short linear ramp reads as a hard band rather than a fade, so this one is
  // long and eased. The hex suffix is the alpha channel on T.bgCard.
  const ramp=dir=>`linear-gradient(to ${dir}, ${T.bgCard} 0%, ${T.bgCard}e8 14%, ${T.bgCard}c4 30%, ${T.bgCard}8e 48%, ${T.bgCard}54 66%, ${T.bgCard}22 84%, ${T.bgCard}00 100%)`;
  return{ref,top,bot,ramp};
}
function FadeScroll({children,T,fadeKey,height=36,className,style,wrapStyle}){
  const edge=useEdgeFade(true,T,fadeKey);
  return(
    <div style={{position:'relative',flex:1,minHeight:0,display:'flex',flexDirection:'column',...wrapStyle}}>
      <div ref={edge.ref} className={className} style={{overflowY:'auto',flex:1,minHeight:0,...style}}>{children}</div>
      <EdgeFades fade={edge} height={height}/>
    </div>
  );
}
function EdgeFades({fade,height=96,top=true,bottom=true}){
  const on=1;
  return(<>
    {top&&<div aria-hidden style={{position:'absolute',top:0,left:0,right:0,height,pointerEvents:'none',opacity:fade.top?on:0,transition:'opacity .18s ease',background:fade.ramp('bottom')}}/>}
    {bottom&&<div aria-hidden style={{position:'absolute',bottom:0,left:0,right:0,height,pointerEvents:'none',opacity:fade.bot?on:0,transition:'opacity .18s ease',background:fade.ramp('top')}}/>}
  </>);
}

// How far a sheet has to be dragged before it dismisses. 80px was a long,
// deliberate haul with no reward for speed, so a flick — the thing anyone
// actually does — did nothing at all. A short fast one counts now, on the same
// terms the reading pane already uses for its page-turn swipe.
const SHEET_DISMISS_PX=55;
const SHEET_FLICK_V=0.35; // px per ms
const SHEET_FLICK_PX=18;
// A sheet title is one line. The row between the back button and its mirror
// is fixed, the words are not, and Menus & Buttons scales the type, so a title
// too long for the row shrinks just enough to fit rather than wrapping under
// itself; one that fits is left at full size. Re-fitted on every render, on
// resize, and whenever a font finishes loading, so a face that arrives after
// the first measure cannot leave it too wide.
// The word is centred as a block rather than aligned as text: text wider than
// its box starts at the left edge and runs off the right, so a pixel of
// mismeasure pushed the whole title sideways. Centred this way it spills
// evenly both sides and is never clipped.
function FitTitle({style,children}){
  const box=useRef(null),word=useRef(null);
  useLayoutEffect(()=>{
    const el=box.current,w=word.current;if(!el||!w)return;
    const fit=()=>{
      el.style.fontSize=style.fontSize;
      const room=el.clientWidth,need=w.offsetWidth;
      if(room>0&&need>room)el.style.fontSize=`calc(${style.fontSize} * ${((room-1)/need).toFixed(4)})`;
    };
    fit();
    const f=document.fonts;
    if(f){f.ready.then(fit);f.addEventListener&&f.addEventListener('loadingdone',fit);}
    window.addEventListener('resize',fit);
    return()=>{window.removeEventListener('resize',fit);if(f&&f.removeEventListener)f.removeEventListener('loadingdone',fit);};
  });
  return(
    <div ref={box} style={{...style,display:'flex',justifyContent:'center',whiteSpace:'nowrap'}}>
      {/* Letter-spacing trails the last letter as well; the same space before
          the first puts the letters themselves on the centre line. */}
      <span ref={word} style={{paddingLeft:style.letterSpacing}}>{children}</span>
    </div>
  );
}
function Modal({title,onClose,children,footer,wide,T,topSheet,onBack,isClosing,hideBack,fade,subHeader}){
  const{ref:panelRef,handlers:dragHandlers}=useSheetDrag(-1,onClose); // top sheet: leaves upwards
  const modalOverlayRef=React.useRef(null);
  const edge=useEdgeFade(fade,T);
  React.useEffect(()=>{
    if(!topSheet)return;
    const el=modalOverlayRef.current;
    if(!el)return;
    const prevent=(e)=>{
      let node=e.target;
      while(node&&node!==el){
        const oy=window.getComputedStyle(node).overflowY;
        if((oy==='auto'||oy==='scroll')&&node.scrollHeight-node.clientHeight>60)return;
        node=node.parentNode;
      }
      e.preventDefault();
    };
    el.addEventListener('touchmove',prevent,{passive:false});
    return()=>el.removeEventListener('touchmove',prevent);
  },[topSheet]);
  return(
    <div ref={modalOverlayRef} className={topSheet?"modal-overlay modal-topsheet-overlay":"modal-overlay"} onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',...(topSheet?{top:topSheet,right:0,bottom:0,left:0,zIndex:185,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(3px)','--ts-h':topSheet+'px'}:{inset:0,zIndex:200,background:'rgba(0,0,0,0.72)',backdropFilter:'blur(4px)'}),display:'flex',alignItems:'center',justifyContent:'center',padding:20,...(isClosing&&topSheet?{opacity:0,transition:'opacity .25s ease-in'}:{})}}>
      <div className={topSheet?(isClosing?'modal-in modal-panel modal-topsheet-panel slide-down-sheet-out':'modal-in modal-panel modal-topsheet-panel'):'modal-in modal-panel'} style={{background:T.bgCard,...(topSheet?{borderBottom:`2px solid ${T.bdA}`}:{border:`1px solid ${T.bdA}`}),borderRadius:topSheet?'0 0 18px 18px':14,width:`min(95vw,${wide?840:700}px)`,maxHeight:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 20px 60px rgba(0,0,0,0.5)',}} ref={panelRef}>
        {topSheet?(
          <div style={{background:T.bgCard,padding:'20px 18px 14px',position:'relative',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            {!hideBack&&(
              <div style={{position:'absolute',left:18,top:20,bottom:14,display:'flex',alignItems:'center'}}>
                <SheetBackBtn onClick={onBack||onClose} T={T} title={onBack?'Back':'Close'}/>
              </div>
            )}
            <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>{title}</FitTitle>
          </div>
        ):(
          <>
            <div style={{height:3,background:T.accentLine}}/>
            <div style={{background:T.bgCH,borderBottom:`1px solid ${T.bdA}`,padding:'16px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
              <span style={{fontFamily:FS,fontSize:U(15),fontWeight:600,color:T.gT,letterSpacing:'0.06em'}}>{title}</span>
              <NavIconBtn ch="✕" onClick={onClose} T={T} title="Close"/>
            </div>
          </>
        )}
        {subHeader&&(
          <div className="modal-subhead" style={{flexShrink:0,padding:'0 24px 16px'}}>{subHeader}</div>
        )}
        <div style={{position:'relative',flex:1,minHeight:0,display:'flex',flexDirection:'column'}}>
          <div ref={edge.ref} className="modal-body" style={{overflowY:'auto',flex:1,minHeight:0,padding:'22px 24px'}}>{children}</div>
          {/* 'soft' is shorter, for lists of cards: the full height swallowed
              most of a card at each edge. */}
          {fade&&<EdgeFades fade={edge} height={fade==='soft'?44:96}/>}
        </div>
        {footer&&<div style={{padding:'12px 20px',display:'flex',justifyContent:'flex-end',gap:10,background:T.bgCard,flexShrink:0}}>{footer}</div>}
        {topSheet&&<div {...dragHandlers} style={{position:'relative',display:'flex',justifyContent:'center',padding:'6px 0 10px',flexShrink:0,touchAction:'none',cursor:'grab'}}><GripReach up/><div style={{width:36,height:4,background:T.bdA,borderRadius:2}}/></div>}
        {topSheet&&<div style={{height:3,background:T.accentLine,flexShrink:0}}/>}
      </div>
    </div>
  );
}

function ConfirmDialog({title,message,confirmLabel,cancelLabel,onConfirm,onCancel,danger,T,children}){
  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onCancel();}} style={{position:'fixed',inset:0,zIndex:500,background:'rgba(0,0,0,0.78)',display:'flex',alignItems:'center',justifyContent:'center',padding:24,backdropFilter:'blur(5px)'}}>
      <div className="modal-in" style={{background:danger?'#180606':T.bgCard,border:`2px solid ${danger?'#8a2020':T.bdA}`,borderRadius:14,width:'min(92vw,480px)',maxHeight:'86vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:danger?'0 32px 80px rgba(140,10,10,0.4)':'0 32px 80px rgba(0,0,0,0.7)'}}>
        <div style={{height:3,background:danger?'linear-gradient(90deg,#5a1010,#c83030,#5a1010)':T.accentLine,flexShrink:0}}/>
        {/* Scrolls rather than growing: a long message used to push the buttons
            off the bottom of the screen where they could not be reached. */}
        <div style={{padding:'22px 26px 16px',overflowY:'auto',flex:1,minHeight:0}}>
          <div style={{fontFamily:FS,fontSize:U(14),fontWeight:600,letterSpacing:'0.06em',color:danger?'#f08080':T.gT,marginBottom:12}}>{title}</div>
          <div style={{fontFamily:FB,fontSize:UH(17),color:danger?'#c09090':T.mut,lineHeight:1.7}}>{message}</div>
          {children}
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'16px 26px',background:'rgba(0,0,0,0.2)',borderTop:`1px solid ${danger?'#4a1212':T.bdA}`,flexShrink:0}}>
          <SBtn ch={cancelLabel||'Cancel'} onClick={onCancel} T={T}/>
          {confirmLabel&&<PBtn ch={confirmLabel} onClick={onConfirm} T={T} danger={danger}/>}
        </div>
      </div>
    </div>
  );
}

function Legend({T,refLabel}){
  const items=[
    {bg:T.blue,txt:T.blueTxt,label:'Reference',detail:refLabel||'Ref'},
    {bg:T.green,txt:T.greenTxt,label:'Faithful',detail:'TR'},
    {bg:T.red,txt:T.redTxt,label:'Corrupt',detail:'Alex.'},
    {bg:T.dif,txt:T.difTxt,label:'Differs'},
    {bg:T.ora,txt:T.oraTxt,label:'Partial'},
    {bg:T.pur,txt:T.purTxt,label:'Absent'},
  ];
  return(
    <div className="no-print" style={{display:'flex',alignItems:'center',padding:'7px 10px',background:T.bg2,borderBottom:`1px solid ${T.bd}`,overflowX:'auto',WebkitOverflowScrolling:'touch',flexShrink:0,scrollbarWidth:'none',msOverflowStyle:'none'}}>
      <span style={{fontFamily:FS,fontSize:UL(7),letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,marginRight:8,flexShrink:0}}>Key</span>
      <div style={{display:'flex',gap:5,alignItems:'center',minWidth:'max-content'}}>
        {items.map(({bg,txt,label,detail})=>(
          <div key={label} style={{display:'inline-flex',alignItems:'center',gap:4,background:bg,border:`1px solid ${txt}44`,borderRadius:20,padding:'4px 10px 4px 8px',flexShrink:0}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:txt,flexShrink:0}}/>
            <span style={{fontFamily:FS,fontSize:UL(8.5),color:txt,fontWeight:600,letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{label}</span>
            {detail&&<span style={{fontFamily:FB,fontSize:UL(9),color:txt+'aa',lineHeight:1,whiteSpace:'nowrap',fontStyle:'italic'}}>{detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function RefDD({bkN,setBkN,ch,setCh,vs,setVs,T,err}){
  const bk=BIBLE.find(b=>b.n===bkN)||null;const chC=bk?bk.v.length:0;const vsC=(bk&&ch)?bk.v[ch-1]||0:0;
  const s=(a)=>({background:T.bgIn,border:`1px solid ${err?'#8a2020':T.bd}`,borderRadius:6,color:a?T.mut:T.dim,fontFamily:FB,fontSize:U(14),padding:'7px 8px',opacity:a?1:.5,outline:'none'});
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
  const eyeStyle={position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:T.gM,cursor:'pointer',padding:0,width:34,height:34,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1};
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
      <style>{CSS}</style>
      <div className="fade-up" style={{textAlign:'center',marginBottom:32}}>
        <div style={{fontFamily:FS,fontSize:UH(26),fontWeight:700,color:T.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
        <div style={{fontFamily:FB,fontStyle:'italic',color:T.gM,fontSize:U(14),lineHeight:1.7}}>"The words of the LORD are pure words" — Psalm 12:6</div>
      </div>
      <div className="modal-in fade-up stagger-1" style={{background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.6)'}}>
        <div style={{height:3,background:T.accentLine}}/>
        <div style={{padding:'28px 32px'}}>
          <div style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:6,textAlign:'center'}}>Set New Password</div>
          <div style={{fontFamily:FB,fontSize:U(13),color:T.mut,textAlign:'center',marginBottom:22,lineHeight:1.6}}>Choose a new password for your account.</div>
          {msg&&<div style={{marginBottom:16,padding:'10px 14px',background:T.green,border:`1px solid ${T.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:T.greenTxt,lineHeight:1.6}}>{msg}</div>}
          {err&&<div style={{marginBottom:16,padding:'10px 14px',background:T.red,border:`1px solid ${T.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:T.redTxt}}>{err}</div>}
          {!msg&&<>
            <div style={{marginBottom:14}}>
              <Lbl c="New Password" T={T}/>
              <div style={{position:'relative'}}>
                <input className="s-btn" type={showPw?'text':'password'} value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" style={pwInputStyle}/>
                <button type="button" onClick={()=>setShowPw(v=>!v)} style={eyeStyle} title={showPw?'Hide password':'Show password'} aria-label={showPw?'Hide password':'Show password'}><PwEye shown={showPw}/></button>
              </div>
            </div>
            <div style={{marginBottom:22}}>
              <Lbl c="Confirm Password" T={T}/>
              <div style={{position:'relative'}}>
                <input className="s-btn" type={showPw?'text':'password'} value={pw2} onChange={e=>setPw2(e.target.value)} onKeyDown={e=>e.key==='Enter'&&doUpdate()} placeholder="••••••••" style={pwInputStyle}/>
              </div>
            </div>
            <button type="button" onClick={doUpdate} disabled={busy} style={{width:'100%',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',padding:'10px 0',fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?.6:1}}>{busy?'…':'Update Password'}</button>
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
  // Offline versions for dynamic subtitle
  const[offlineVids,setOfflineVids]=useState(null);
  useEffect(()=>{
    (async()=>{
      try{
        const checks=await Promise.all(PUBLIC_VERSIONS.map(async v=>({v,dl:await idbIsDownloaded(v.id).catch(()=>false)})));
        setOfflineVids(checks.filter(c=>c.dl).map(c=>c.v.label));
      }catch{setOfflineVids([]);}
    })();
  },[]);

  const pwInputStyle={width:'100%',background:D.bgIn,border:`1px solid ${D.bd}`,borderRadius:6,color:D.body,fontFamily:FB,fontSize:16,padding:'9px 42px 9px 13px',outline:'none',boxSizing:'border-box'};
  const eyeStyle={position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:D.gM,cursor:'pointer',padding:0,width:34,height:34,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1};

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
      <style>{CSS}</style>
      <div className="fade-up" style={{textAlign:'center',marginBottom:32}}>
        {offlineVids&&offlineVids.length>0&&(
          <div style={{fontFamily:FS,fontSize:U(11),letterSpacing:'0.3em',textTransform:'uppercase',color:D.gD,marginBottom:10,fontWeight:500}}>{offlineVids.join(' / ')}</div>
        )}
        <div style={{fontFamily:FS,fontSize:UH(26),fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
        <div style={{fontFamily:FB,fontStyle:'italic',color:D.gM,fontSize:U(14),lineHeight:1.7}}>"The words of the LORD are pure words" — Psalm 12:6</div>
      </div>

      {/* Login card */}
      <div className="modal-in fade-up stagger-1" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,480px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.6)'}}>
        <div style={{height:3,background:D.accentLine}}/>
        <div style={{padding:'22px 22px 20px'}}>
          <div style={{fontFamily:FS,fontSize:U(16),fontWeight:600,color:D.gT,letterSpacing:'0.08em',marginBottom:18,textAlign:'center'}}>Sign In</div>
          {msg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.greenTxt,lineHeight:1.6}}>{msg}</div>}
          {err&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.redTxt,wordBreak:'break-word'}}>{err}</div>}
          <div style={{marginBottom:12}}><Lbl c="Email" T={D}/><Inp val={email} set={setEmail} ph="you@example.com" T={D} type="email"/></div>
          <div style={{marginBottom:18}}>
            <Lbl c="Password" T={D}/>
            <div style={{position:'relative'}}>
              <input className="s-btn" type={showPw?'text':'password'} value={pw} onChange={e=>setPw(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&doSignIn()} placeholder="••••••••" style={pwInputStyle}/>
              <button type="button" onClick={()=>setShowPw(v=>!v)} style={eyeStyle} title={showPw?'Hide password':'Show password'} aria-label={showPw?'Hide password':'Show password'}><PwEye shown={showPw}/></button>
            </div>
          </div>
          <button type="button" onClick={doSignIn} disabled={busy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:U(12),letterSpacing:'0.12em',textTransform:'uppercase',padding:'13px 0',fontWeight:600,cursor:busy?'default':'pointer',opacity:busy?.6:1}}>{busy?'…':'Sign In'}</button>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginTop:16}}>
            <button type="button" onClick={()=>setShowSignup(true)} style={{background:'none',border:'none',color:D.gT,fontFamily:FB,fontSize:U(13),fontWeight:600,cursor:'pointer',padding:'2px 0',textDecoration:'underline',textUnderlineOffset:3,whiteSpace:'nowrap'}}>Create an account</button>
            <button type="button" onClick={()=>{setShowForgot(true);setForgotEmail(email);}} style={{background:'none',border:'none',color:D.dim,fontFamily:FB,fontSize:U(13),cursor:'pointer',padding:'2px 0',textDecoration:'underline',textUnderlineOffset:3,whiteSpace:'nowrap'}}>Forgot password?</button>
          </div>
        </div>
      </div>
      <div style={{marginTop:16,textAlign:'center'}}>
        <button type="button" onClick={()=>setShowGuestWarning(true)} style={{background:'none',border:'none',color:D.dim,fontFamily:FS,fontSize:U(13),letterSpacing:'0.08em',cursor:'pointer',fontWeight:400,textDecoration:'underline',padding:0}}>Continue without an account</button>
      </div>

      {/* Guest warning modal */}
      {showGuestWarning&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&setShowGuestWarning(false)}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,480px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{fontFamily:FS,fontSize:U(16),fontWeight:600,color:D.gT,letterSpacing:'0.08em',marginBottom:16,textAlign:'center'}}>Guest Mode</div>
              <div style={{fontFamily:FB,fontSize:U(14),color:D.mut,lineHeight:1.7,marginBottom:16}}>You can browse and read without an account, but:</div>
              <ul style={{fontFamily:FB,fontSize:U(13),color:D.dim,lineHeight:1.9,margin:'0 0 20px 18px',padding:0}}>
                <li>No data saved between sessions</li>
                <li>No study entries or bookmarks</li>
                <li>No sync across devices</li>
                <li>No personal Bible versions</li>
              </ul>
              <button type="button" onClick={()=>{setShowGuestWarning(false);onAuth({id:'guest',email:'',guest:true});}} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:U(12),letterSpacing:'0.12em',textTransform:'uppercase',padding:'11px 0',fontWeight:600,cursor:'pointer',marginBottom:10}}>Continue as Guest</button>
              <button type="button" onClick={()=>setShowGuestWarning(false)} style={{width:'100%',background:'none',border:`1px solid ${D.bd}`,borderRadius:6,color:D.gM,fontFamily:FS,fontSize:U(12),letterSpacing:'0.1em',padding:'10px 0',cursor:'pointer'}}>Back to Sign In</button>
            </div>
          </div>
        </div>
      )}

      {/* Signup modal */}
      {showSignup&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&closeSignup()}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,480px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:22}}>
                <div style={{fontFamily:FS,fontSize:U(16),fontWeight:600,color:D.gT,letterSpacing:'0.08em'}}>Create Account</div>
                <NavIconBtn ch="✕" onClick={closeSignup} T={D} title="Close"/>
              </div>
              {suMsg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.greenTxt,lineHeight:1.6}}>{suMsg}</div>}
              {suErr&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.redTxt,wordBreak:'break-word'}}>{suErr}</div>}
              <div style={{marginBottom:14}}><Lbl c="Email" T={D}/><Inp val={suEmail} set={setSuEmail} ph="you@example.com" T={D} type="email"/></div>
              <div style={{marginBottom:22}}>
                <Lbl c="Password" T={D}/>
                <div style={{position:'relative'}}>
                  <input className="s-btn" type={showSuPw?'text':'password'} value={suPw} onChange={e=>setSuPw(e.target.value)}
                    onKeyDown={e=>e.key==='Enter'&&doSignUp()} placeholder="••••••••" style={pwInputStyle}/>
                  <button type="button" onClick={()=>setShowSuPw(v=>!v)} style={eyeStyle} title={showSuPw?'Hide password':'Show password'} aria-label={showSuPw?'Hide password':'Show password'}><PwEye shown={showSuPw}/></button>
                </div>
              </div>
              <button type="button" onClick={doSignUp} disabled={suBusy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:U(12),letterSpacing:'0.12em',textTransform:'uppercase',padding:'11px 0',fontWeight:600,cursor:suBusy?'default':'pointer',opacity:suBusy?.6:1}}>{suBusy?'…':'Create Account'}</button>
              <div style={{textAlign:'center',marginTop:14}}>
                <button type="button" onClick={closeSignup} style={{background:'none',border:'none',color:D.gM,fontFamily:FS,fontSize:U(12),letterSpacing:'0.1em',cursor:'pointer',fontWeight:500,textDecoration:'underline'}}>Already have an account? Sign in</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Forgot password modal */}
      {showForgot&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&closeForgot()}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,480px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <div style={{fontFamily:FS,fontSize:U(16),fontWeight:600,color:D.gT,letterSpacing:'0.08em'}}>Reset Password</div>
                <NavIconBtn ch="✕" onClick={closeForgot} T={D} title="Close"/>
              </div>
              <div style={{fontFamily:FB,fontSize:U(13),color:D.mut,marginBottom:20,lineHeight:1.6}}>Enter your email and we'll send you a link to reset your password.</div>
              {forgotMsg&&<div style={{marginBottom:16,padding:'10px 14px',background:D.green,border:`1px solid ${D.greenTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.greenTxt,lineHeight:1.6}}>{forgotMsg}</div>}
              {forgotErr&&<div style={{marginBottom:16,padding:'10px 14px',background:D.red,border:`1px solid ${D.redTxt}40`,borderRadius:6,fontFamily:FB,fontSize:U(14),color:D.redTxt}}>{forgotErr}</div>}
              {!forgotMsg&&<>
                <div style={{marginBottom:20}}><Lbl c="Email" T={D}/><Inp val={forgotEmail} set={setForgotEmail} ph="you@example.com" T={D} type="email"/></div>
                <button type="button" onClick={doForgotPassword} disabled={forgotBusy} style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:6,color:D.gT,fontFamily:FS,fontSize:U(12),letterSpacing:'0.12em',textTransform:'uppercase',padding:'11px 0',fontWeight:600,cursor:forgotBusy?'default':'pointer',opacity:forgotBusy?.6:1}}>{forgotBusy?'…':'Send Reset Link'}</button>
              </>}
              {forgotMsg&&<button type="button" onClick={closeForgot} style={{width:'100%',marginTop:4,background:'none',border:`1px solid ${D.bd}`,borderRadius:6,color:D.gM,fontFamily:FS,fontSize:U(12),letterSpacing:'0.1em',padding:'10px 0',cursor:'pointer'}}>Back to Sign In</button>}
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
const CAT_COLORS=['#62c484','#6ab0f5','#e4cc78','#f08080','#c488c8','#f0a060','#80c8c8','#a0a0b8'];

// The verses a bookmark covers. A range lives only in its label ("Galatians
// 4:2-3", "Psalms 23:1, 4"); a chapter bookmark covers no one verse.
function bmVerses(bm){
  if(bm.verse==null)return[];
  const m=String(bm.label||'').match(/\s\d+:([\d,\s-]+)$/);
  if(!m)return[bm.verse];
  const out=[];
  for(const part of m[1].split(',')){
    const[a,b]=part.split('-').map(x=>parseInt(x,10));
    if(!a)continue;
    for(let v=a;v<=(b&&b>=a?Math.min(b,a+60):a);v++)out.push(v);
  }
  return out.length?out:[bm.verse];
}
// Laid out as a verse is in Commentaries: the reference in a band with its
// controls, then the words themselves in the reading font, then the note.
function BmCard({bm,T,versions,onDelete,onOpen,onUpdate,categories,user,showCatPicker,words,px,family}){
  const bk=BIBLE.find(b=>b.n===bm.book_num);
  const ver=versions.find(v=>v.id===bm.version_id);
  const verLabel=ver?.label||(bm.version_id||'').toUpperCase();
  const ref=`${bk?.name||'?'} ${bm.chapter}${bm.verse?':'+bm.verse:''}`;
  // The heading is always the reference. The label column carries it too,
  // spelled across a range ("Galatians 4:2-3"), so prefer that spelling when
  // the column holds one. A label written before the save form existed held a
  // note instead, and still reads as one.
  const isRangeRef=bm.label&&bk&&(bm.label.startsWith(bk.name)||(bk.nameES&&bm.label.startsWith(bk.nameES)));
  const titleRef=isRangeRef?bm.label:ref;
  const displayNote=bm.note!=null?bm.note:(isRangeRef?null:bm.label);

  const[editNote,setEditNote]=useState(false);
  const[noteVal,setNoteVal]=useState(displayNote||'');
  const[showDelConfirm,setShowDelConfirm]=useState(false);

  function openEditor(){setNoteVal(displayNote||'');setEditNote(true);}
  function saveNote(){onUpdate(bm.id,{note:noteVal});setEditNote(false);}
  function cancelNote(){setNoteVal(displayNote||'');setEditNote(false);}
  function moveCat(catId){onUpdate(bm.id,{categoryId:catId||null});}

  const box={border:`1px solid ${T.bd}`,borderRadius:7,height:32,minWidth:32,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 9px',lineHeight:1,cursor:'pointer',flexShrink:0,boxSizing:'border-box'};
  const hasBody=words!==undefined||displayNote||editNote||(showCatPicker&&categories.length>0);
  return(
    <div style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:10,overflow:'hidden'}}>
      <div style={{display:'flex',alignItems:'center',gap:6,padding:'7px 10px 7px 14px',background:T.bgSec,borderBottom:hasBody?`1px solid ${T.bdS}`:'none'}}>
        <div style={{flex:1,minWidth:0}}>
          <span style={{fontFamily:FS,fontSize:Math.min(19,Math.round(px*0.85)),fontWeight:700,color:T.gT,letterSpacing:'0.04em'}}>{titleRef}</span>
          <span style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600,color:T.dim,marginLeft:8,whiteSpace:'nowrap'}}>{verLabel}</span>
        </div>
        <button type="button" className="s-btn s-ghost" onClick={()=>onOpen(bm)}
          style={{...box,background:'none',color:T.gM,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.12em',textTransform:'uppercase',fontWeight:600,padding:'0 11px'}}>Open</button>
        {user&&<>
          <button type="button" onClick={()=>editNote?cancelNote():openEditor()} title={displayNote?'Edit note':'Add note'} aria-label={displayNote?'Edit note':'Add note'}
            style={{...box,background:editNote||displayNote?T.gF:'none',borderColor:editNote||displayNote?T.gD:T.bd,color:editNote||displayNote?T.gT:T.dim,fontFamily:FS,fontSize:U(14)}}>✎</button>
          <button type="button" className="s-btn s-danger" onClick={()=>setShowDelConfirm(true)} title="Delete bookmark" aria-label="Delete bookmark"
            style={{...box,background:'none',borderColor:`${T.redTxt}55`,color:T.redTxt,fontFamily:FB,fontSize:U(14)}}>✕</button>
        </>}
      </div>
      {hasBody&&(
        <div style={{padding:'10px 14px 10px'}}>
          {words!==undefined&&(
            <div style={{fontFamily:family,fontSize:px,color:T.mut,lineHeight:1.55,fontStyle:words?'normal':'italic',display:'-webkit-box',WebkitLineClamp:4,WebkitBoxOrient:'vertical',overflow:'hidden'}}>
              {words||'…'}
            </div>
          )}
          {!editNote&&displayNote&&(
            <div style={{fontFamily:family,fontSize:px,color:T.body,lineHeight:1.55,whiteSpace:'pre-wrap',...(words!==undefined?{borderTop:`1px solid ${T.bdS}`,marginTop:8,paddingTop:8}:{})}}>{displayNote}</div>
          )}
          {editNote&&(
            <div style={{marginTop:words!==undefined?8:0}}>
              <textarea value={noteVal} onChange={e=>setNoteVal(e.target.value)} rows={3} autoFocus
                style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:6,color:T.body,fontFamily:family,fontSize:Math.max(16,px),padding:'9px 12px',outline:'none',resize:'vertical',lineHeight:1.55}}/>
              <div style={{display:'flex',gap:6,marginTop:6}}>
                <button onClick={saveNote} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.12em',textTransform:'uppercase',padding:'9px 16px',cursor:'pointer',fontWeight:600}}>Save</button>
                <button onClick={cancelNote} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.dim,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.12em',textTransform:'uppercase',padding:'9px 16px',cursor:'pointer',fontWeight:600}}>Cancel</button>
              </div>
            </div>
          )}
          {/* Category picker — shown when panel-level assign mode is on */}
          {showCatPicker&&categories.length>0&&(
            <div style={{marginTop:words!==undefined||displayNote||editNote?10:0,display:'flex',flexWrap:'wrap',gap:5}}>
              <button onClick={()=>moveCat(null)}
                style={{background:bm.category_id==null?T.gF:'none',border:`1px solid ${bm.category_id==null?T.gD:T.bd}`,borderRadius:12,color:bm.category_id==null?T.gT:T.dim,fontFamily:FS,fontSize:U(11),padding:'5px 13px',cursor:'pointer',fontWeight:bm.category_id==null?600:400}}>
                None
              </button>
              {categories.map(c=>(
                <button key={c.id} onClick={()=>moveCat(c.id)}
                  style={{background:bm.category_id===c.id?c.color+'28':'none',border:`1.5px solid ${bm.category_id===c.id?c.color:T.bd}`,borderRadius:12,color:bm.category_id===c.id?c.color:T.dim,fontFamily:FS,fontSize:U(11),padding:'5px 13px',cursor:'pointer',fontWeight:bm.category_id===c.id?600:400}}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {showDelConfirm&&<ConfirmDialog T={T} danger
        title="Delete Bookmark"
        message={`Remove "${titleRef}"?\n\nTo move it to a different category instead, use Assign Categories at the top of the list.`}
        confirmLabel="Delete" cancelLabel="Cancel"
        onConfirm={()=>{setShowDelConfirm(false);onDelete(bm.id);}}
        onCancel={()=>setShowDelConfirm(false)}/>}
    </div>
  );
}

// A category is a card in its own colour whose band opens it, as the
// Introduction does in Commentaries, with its bookmarks as cards inside.
function CatSection({cat,bookmarks,T,versions,onDelete,onOpen,onUpdate,onRename,onDeleteCat,categories,user,showCatPicker,catToggle,cardProps}){
  const[open,setOpen]=useState(false);
  const[renaming,setRenaming]=useState(false);
  useEffect(()=>{if(catToggle)setOpen(catToggle.action==='expand');},[catToggle]);
  const[nameVal,setNameVal]=useState(cat.name);
  const[colorIdx,setColorIdx]=useState(CAT_COLORS.indexOf(cat.color)<0?0:CAT_COLORS.indexOf(cat.color));
  const[showDelCatConfirm,setShowDelCatConfirm]=useState(false);

  function saveRename(){
    onRename(cat.id,{name:nameVal||cat.name,color:CAT_COLORS[colorIdx]});
    setRenaming(false);
  }
  const box={border:`1px solid ${T.bd}`,borderRadius:7,height:32,minWidth:32,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:'0 9px',lineHeight:1,cursor:'pointer',flexShrink:0,boxSizing:'border-box'};
  return(
    <div style={{border:`1px solid ${cat.color}66`,background:T.bgCard,borderRadius:10,marginBottom:10,overflow:'hidden'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'7px 10px 7px 14px',background:T.bgSec,borderBottom:open||renaming?`1px solid ${cat.color}44`:'none',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none'}} onClick={()=>!renaming&&setOpen(v=>!v)}>
        <span style={{color:T.gM,display:'inline-flex',flexShrink:0}}><Caret open={open} size={12}/></span>
        <span style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600,color:T.gT,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{cat.name}</span>
        <span style={{fontFamily:FS,fontSize:UL(10),color:T.dim,marginRight:4}}>{bookmarks.length}</span>
        {user&&!renaming&&<>
          <button type="button" onClick={e=>{e.stopPropagation();setRenaming(true);setOpen(true);}} title="Rename" aria-label={`Rename ${cat.name}`}
            style={{...box,background:'none',color:T.dim,fontFamily:FS,fontSize:U(14)}}>✎</button>
          <button type="button" onClick={e=>{e.stopPropagation();setShowDelCatConfirm(true);}} title="Delete category" aria-label={`Delete ${cat.name}`}
            style={{...box,background:'none',borderColor:`${T.redTxt}55`,color:T.redTxt}}>
            <svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,3 11,3"/><path d="M4.5,3V2a.5.5,0,0,1,.5-.5h2a.5.5,0,0,1,.5.5v1"/><rect x="2" y="3" width="8" height="7.5" rx=".5"/>
              <line x1="4.5" y1="5.5" x2="4.5" y2="9"/><line x1="7.5" y1="5.5" x2="7.5" y2="9"/>
            </svg>
          </button>
        </>}
      </div>
      {/* Rename form — stacked rows, no horizontal overflow */}
      {renaming&&(
        <div style={{margin:'10px 10px 0',padding:'8px 10px',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8}} onClick={e=>e.stopPropagation()}>
          <input value={nameVal} onChange={e=>setNameVal(e.target.value)} autoFocus onKeyDown={e=>e.key==='Enter'&&saveRename()}
            style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:5,color:T.body,fontFamily:FS,fontSize:16,padding:'6px 8px',outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <div style={{display:'flex',gap:4,flex:1,flexWrap:'wrap'}}>
              {CAT_COLORS.map((c,i)=>(
                <button key={c} onClick={()=>setColorIdx(i)}
                  style={{width:18,height:18,borderRadius:'50%',background:c,border:`2px solid ${i===colorIdx?T.gT:'transparent'}`,cursor:'pointer',padding:0,flexShrink:0}}/>
              ))}
            </div>
            <button onClick={()=>setRenaming(false)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:U(11),padding:'7px 14px',cursor:'pointer',flexShrink:0}}>Cancel</button>
            <button onClick={saveRename} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:U(11),padding:'7px 14px',cursor:'pointer',fontWeight:600,flexShrink:0}}>Save</button>
          </div>
        </div>
      )}
      {open&&<div style={{padding:'10px 10px 0'}}>
        {bookmarks.length===0
          ?<div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(14),padding:'2px 4px 10px'}}>Empty category</div>
          :bookmarks.map(bm=><BmCard key={bm.id} bm={bm} {...cardProps(bm)}/>)
        }
      </div>}
      {showDelCatConfirm&&<ConfirmDialog T={T} danger
        title={`Delete "${cat.name}"?`}
        message="All bookmarks in this category will become uncategorized. This cannot be undone."
        confirmLabel="Delete" cancelLabel="Cancel"
        onConfirm={()=>{setShowDelCatConfirm(false);onDeleteCat(cat.id);}}
        onCancel={()=>setShowDelCatConfirm(false)}/>}
    </div>
  );
}

function BookmarksPanel({T,bookmarks,categories,onDelete,onOpen,onClose,onBack,onUpdate,onAddCat,onDeleteCat,onUpdateCat,versions,user,navH,isClosing,readFont}){
  const[newCatName,setNewCatName]=useState('');
  const[newCatColor,setNewCatColor]=useState(0);
  const[addingCat,setAddingCat]=useState(false);
  const[viewAll,setViewAll]=useState(false);
  const[assigningCats,setAssigningCats]=useState(false);
  const[catToggle,setCatToggle]=useState(null);

  async function createCat(){
    if(!newCatName.trim())return;
    await onAddCat(newCatName.trim(),CAT_COLORS[newCatColor]);
    setNewCatName('');setNewCatColor(0);setAddingCat(false);
  }

  const grouped=categories.map(cat=>({cat,items:bookmarks.filter(bm=>bm.category_id===cat.id)}));
  const uncategorized=bookmarks.filter(bm=>!bm.category_id);
  const hasCats=categories.length>0;
  // Each bookmark shows its verse, in the version it was saved in, the way
  // Highlights does: a chapter at a time, four at once.
  const[texts,setTexts]=useState({});
  const asked=useRef(new Set()),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;},[]);
  const need=[...new Set(bookmarks.filter(b=>b.verse!=null).map(b=>`${b.version_id}|${b.book_num}|${b.chapter}`))].filter(k=>!asked.current.has(k));
  useEffect(()=>{
    if(!need.length)return;
    need.forEach(k=>asked.current.add(k));
    let i=0;
    const work=async()=>{
      while(alive.current&&i<need.length){
        const k=need[i++];const[vid,b,c]=k.split('|');
        let rows=[];try{rows=await dbGetChapter(vid,+b,+c);}catch{}
        if(!alive.current)return;
        setTexts(t=>{const n={...t,[`${k}|loaded`]:true};for(const r of rows)n[`${k}|${r.verse}`]=String(r.text||'').replace(/<[^>]+>/g,'');return n;});
      }
    };
    Promise.all([work(),work(),work(),work()]);
  },[need.join(',')]);
  // undefined: no verse to show (a chapter bookmark, or text not on this
  // device); '' while it loads.
  function wordsFor(bm){
    if(bm.verse==null)return undefined;
    const k=`${bm.version_id}|${bm.book_num}|${bm.chapter}`;
    if(!texts[`${k}|loaded`])return'';
    const w=bmVerses(bm).map(v=>texts[`${k}|${v}`]).filter(Boolean).join(' ');
    return w||undefined;
  }
  const px=cmPx(readFont?.size||31);
  const cardProps=bm=>({T,versions,onDelete,onOpen,onUpdate,categories,user,showCatPicker:assigningCats,words:wordsFor(bm),px,family:readFont?.family||FB});
  const small={fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600};
  const toggle=on=>({...small,flex:1,background:on?T.gF:'none',border:`1px solid ${on?T.gD:T.bd}`,borderRadius:8,color:on?T.gT:T.gM,padding:'11px 0',cursor:'pointer'});

  return(
    <Modal title="Bookmarks" onClose={onClose} onBack={onBack} T={T} topSheet={navH} isClosing={isClosing} fade="soft" footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {!user&&<div style={{background:T.bgCH,border:`1px solid ${T.bd}`,borderRadius:8,padding:'12px 14px',marginBottom:16,display:'flex',gap:10,alignItems:'flex-start'}}>
        <span style={{fontSize:16,flexShrink:0}}>⚠︎</span>
        <div>
          <div style={{fontFamily:FS,fontSize:U(11),fontWeight:600,letterSpacing:'0.08em',color:T.gT,marginBottom:4}}>SIGN IN REQUIRED</div>
          <div style={{fontFamily:FB,fontSize:U(13),color:T.mut,lineHeight:1.6}}>Bookmarks are saved to your account. Sign in to save and view bookmarks.</div>
        </div>
      </div>}

      {user&&!user.guest&&(
        <div style={{marginBottom:12}}>
          {/* New category form — stacked rows, mobile-safe */}
          {addingCat?(
            <div style={{padding:'10px',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,marginBottom:8}}>
              <input value={newCatName} onChange={e=>setNewCatName(e.target.value)} autoFocus placeholder="Category name…"
                onKeyDown={e=>e.key==='Enter'&&createCat()}
                style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:5,color:T.body,fontFamily:FS,fontSize:U(13),padding:'7px 8px',outline:'none',marginBottom:8}}/>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{display:'flex',gap:4,flex:1,flexWrap:'wrap'}}>
                  {CAT_COLORS.map((c,i)=>(
                    <button key={c} onClick={()=>setNewCatColor(i)}
                      style={{width:20,height:20,borderRadius:'50%',background:c,border:`2px solid ${i===newCatColor?T.gT:'transparent'}`,cursor:'pointer',padding:0,flexShrink:0}}/>
                  ))}
                </div>
                <button onClick={()=>{setAddingCat(false);setNewCatName('');}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:U(11),padding:'8px 14px',cursor:'pointer',flexShrink:0}}>Cancel</button>
                <button onClick={createCat} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'8px 16px',cursor:'pointer',fontWeight:600,flexShrink:0}}>Create</button>
              </div>
            </div>
          ):(
            <button onClick={()=>setAddingCat(true)}
              style={{...small,display:'flex',alignItems:'center',justifyContent:'center',background:'none',border:`1px dashed ${T.gD}`,borderRadius:10,color:T.gT,padding:'11px 14px',cursor:'pointer',width:'100%',boxSizing:'border-box',marginBottom:hasCats?8:0}}>
              ＋ New Category
            </button>
          )}
          {/* View toggles — only shown when categories exist */}
          {hasCats&&(
            <>
              <div style={{display:'flex',gap:8,marginBottom:6}}>
                <button onClick={()=>setViewAll(v=>!v)} style={toggle(viewAll)}>
                  {viewAll?'By Category':'View All'}
                </button>
                <button onClick={()=>setAssigningCats(v=>!v)} style={toggle(assigningCats)}>
                  {assigningCats?'Done Assigning':'Assign Categories'}
                </button>
              </div>
              {!viewAll&&(
                <div style={{display:'flex',gap:8}}>
                  <button onClick={()=>setCatToggle({action:'expand',tick:Date.now()})} style={toggle(false)}>
                    <span style={{display:'inline-flex',alignItems:'center',gap:5,justifyContent:'center'}}><Caret open={false} size={13}/> Expand All</span>
                  </button>
                  <button onClick={()=>setCatToggle({action:'collapse',tick:Date.now()})} style={toggle(false)}>
                    <span style={{display:'inline-flex',alignItems:'center',gap:5,justifyContent:'center'}}><Caret open={true} size={13}/> Collapse All</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {bookmarks.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15)}}>{user?'No bookmarks yet. In Reading Mode, tap any verse to bookmark it.':'No bookmarks. Sign in to save passages.'}</div>}

      {/* Flat list */}
      {viewAll&&hasCats?(
        bookmarks.map(bm=><BmCard key={bm.id} bm={bm} {...cardProps(bm)}/>)
      ):(
        <>
          {grouped.map(({cat,items})=>(
            <CatSection key={cat.id} cat={cat} bookmarks={items} T={T} versions={versions}
              onDelete={onDelete} onOpen={onOpen} onUpdate={onUpdate}
              onRename={onUpdateCat} onDeleteCat={onDeleteCat}
              categories={categories} user={user} showCatPicker={assigningCats} catToggle={catToggle} cardProps={cardProps}/>
          ))}
          {/* Uncategorized reads as the categories' sibling, so it gets a box
              too -- a neutral one, since it has no colour of its own. Without
              any categories there is nothing to be a sibling of, and the cards
              stand on their own. */}
          {uncategorized.length>0&&(hasCats?(
            <div style={{border:`1px solid ${T.bd}`,background:T.bgCard,borderRadius:10,marginTop:10,marginBottom:10,overflow:'hidden'}}>
              <div style={{display:'flex',alignItems:'center',gap:8,padding:'11px 14px',background:T.bgSec,borderBottom:`1px solid ${T.bdS}`}}>
                <span style={{...small,fontSize:UL(10),color:T.dim,flex:1}}>Uncategorized</span>
                <span style={{fontFamily:FS,fontSize:UL(10),color:T.dim}}>{uncategorized.length}</span>
              </div>
              <div style={{padding:'10px 10px 0'}}>
                {uncategorized.map(bm=><BmCard key={bm.id} bm={bm} {...cardProps(bm)}/>)}
              </div>
            </div>
          ):(
            <>{uncategorized.map(bm=><BmCard key={bm.id} bm={bm} {...cardProps(bm)}/>)}</>
          ))}
        </>
      )}
    </Modal>
  );
}

// A reference as the page prints it, in the reading version's language:
// "Prov. 8:22–24" inline, the full book name as a preview's title.
function cmRefLabel(r,lang,full){
  const n=bookName(BIBLE[r.b-1],lang)||'?';
  const tail=r.c2!==r.c?`–${r.c2}:${r.v2}`:r.v2!==r.v?`–${r.v2}`:'';
  return `${full?n:shortBook(n)} ${r.c}:${r.v}${tail}`;
}
// Commentary markup, one paragraph a line, references as links. A line that is
// nothing but bold is a heading: the Treasury's OVERVIEW and RECIPROCAL.
function CmLines({text,T,lang,onRef,px,family=FB,color}){
  if(!text)return null;
  return text.split('\n').map((line,i)=>{
    const runs=markupRuns(line);
    if(runs.length===1&&runs[0].b&&!runs[0].ref)
      return <div key={i} style={{fontFamily:FS,fontSize:Math.max(10,Math.round(px*0.58)),letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,fontWeight:600,margin:i?'12px 0 5px':'0 0 5px'}}>{runs[0].text.trim()}</div>;
    return(
      <div key={i} style={{fontFamily:family,fontSize:px,color:color||T.body,lineHeight:1.55,marginBottom:5,overflowWrap:'anywhere'}}>
        {runs.map((r,j)=>r.ref
          // Inline text rather than a button: a button is a box the line can
          // break after, which left commas starting lines.
          ?<span key={j} role="button" tabIndex={0} onClick={()=>onRef(r.ref)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onRef(r.ref);}}}
              style={{fontWeight:r.b?700:'inherit',color:T.gT,textDecoration:'underline dotted',textDecorationColor:T.gD,textUnderlineOffset:3,cursor:'pointer',whiteSpace:'nowrap'}}>{cmRefLabel(r.ref,lang)}</span>
          :<span key={j} style={r.b||r.i?{fontWeight:r.b?700:undefined,fontStyle:r.i?'italic':undefined,color:r.b?T.gT:undefined}:undefined}>{r.text}</span>)}
      </div>
    );
  });
}
// The Treasury marks where a verse's own cross-references end and the verses
// that point back to it begin. Those can run to dozens, so they start folded.
function splitReciprocal(m){
  const lines=m.split('\n');
  const at=lines.findIndex(l=>/^<b>\s*RECIPROCAL\s*<\/b>$/i.test(l));
  return at<0?[m,'']:[lines.slice(0,at).join('\n'),lines.slice(at+1).join('\n')];
}

// Study → Commentaries. It opens on the chapter being read, and at the verse
// that was selected; its own arrows move on from there without moving Read.
function CommentaryPage({T,navH,vid,lang,book,ch,focus,list,cid,onPick,onStep,onGo,onImport,onDelete,verseHtml,readFont,anySheetOpen,installed,fs,onScroll,onNav,onChoose,verLabel}){
  // The commentary is read like the text it comments on, so it follows
  // Scripture Size (see cmPx).
  const px=cmPx(readFont.size);
  const cm=list.find(c=>c.id===cid)||list[0];
  const[rec,setRec]=useState(undefined); // undefined while loading, null for none
  const[intro,setIntro]=useState(null);
  const[introOpen,setIntroOpen]=useState(false);
  const[texts,setTexts]=useState({});
  const[recipOpen,setRecipOpen]=useState(()=>new Set());
  const[menu,setMenu]=useState(false);
  const[info,setInfo]=useState(null);
  const[preview,setPreview]=useState(null);
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState(null);
  const scrollRef=useRef(null);
  const swipe=useRef(null);
  // The page's own jumps -- to a verse, to a chapter's top -- are not the reader
  // scrolling, and must not count toward full screen.
  const ownScroll=useRef(0);
  const ruleRef=useRef(null);
  useEffect(()=>{
    let alive=true;
    setRec(undefined);setRecipOpen(new Set());setIntroOpen(false);
    Promise.all([idbGetCommentaryChapter(cm.id,book,ch),idbGetCommentaryChapter(cm.id,book,0)])
      .then(([r,i])=>{if(alive){setRec(r);setIntro(i?.o||null);}})
      .catch(()=>{if(alive){setRec(null);setIntro(null);}});
    return()=>{alive=false;};
  },[cm.id,book,ch,installed]);
  useEffect(()=>{
    let alive=true;
    setTexts({});
    dbGetChapter(vid,book,ch).then(rows=>{
      if(!alive)return;
      const m={};for(const r of rows)m[r.verse]=String(r.text||'').replace(/<[^>]+>/g,'');
      setTexts(m);
    }).catch(()=>{});
    return()=>{alive=false;};
  },[vid,book,ch]);
  // Land on the verse it was opened from; a new chapter starts at its top.
  // Only those move the page. Choosing a verse by tapping it, or tapping it
  // again to let it go, leaves the page where it is -- letting go used to read
  // as 'no verse' and sent the page back to the top of the chapter.
  const shownRec=useRef(null);
  useEffect(()=>{
    if(rec===undefined)return;
    const newChapter=shownRec.current!==rec;shownRec.current=rec;
    if(!newChapter&&(!focus||focus.tap))return;
    const el=scrollRef.current;if(!el)return;
    const at=focus&&document.getElementById(`cm-v-${focus.v}`);
    // Measured against the list itself (offsetTop counts from the page), and
    // clear of the nav, which floats over the top of the list.
    ownScroll.current=Date.now()+250;
    el.scrollTop=at?Math.max(0,at.getBoundingClientRect().top-el.getBoundingClientRect().top+el.scrollTop-navH-10):0;
  },[rec,focus]);
  async function openPreview(ref){
    setPreview({ref,rows:null});
    try{
      const rows=[];
      // A range is read to its end, three chapters at most.
      for(let c=ref.c;c<=Math.min(ref.c2,ref.c+2);c++){
        for(const r of await dbGetChapter(vid,ref.b,c)){
          if((c>ref.c||r.verse>=ref.v)&&(c<ref.c2||r.verse<=ref.v2))rows.push({c,v:r.verse,text:r.text});
        }
      }
      setPreview(p=>p&&p.ref===ref?{ref,rows}:p);
    }catch{
      setPreview(p=>p&&p.ref===ref?{ref,rows:[]}:p);
    }
  }
  async function showInfo(c){
    setMenu(false);
    if(c.builtin){const m=await idbGetMeta(`commentary:${c.id}`).catch(()=>null);setInfo({c,info:m?.info||'',notice:TSKE_NOTICE});}
    else setInfo({c,info:c.info||'',notice:null});
  }
  async function pickFile(f){
    if(!f)return;
    setMsg(null);
    if(!/\.cmti$/i.test(f.name)){setMsg({err:true,text:`${f.name} isn't an e-Sword commentary. Choose a .cmti file.`});return;}
    setBusy(true);
    try{const meta=await onImport(f);setMenu(false);setMsg({text:`Added “${meta.title}”.`});}
    catch(e){setMsg({err:true,text:String(e?.message||e)});}
    setBusy(false);
  }
  const bk=BIBLE[book-1];
  const heading=`${bookName(bk,lang)} ${ch}`;
  const card={background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:10,overflow:'hidden'};
  const small={fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600};
  const navBtn={background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'6px 16px',fontWeight:500,cursor:'pointer'};
  return(
    <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0}}>
      <div ref={scrollRef} onScroll={e=>onScroll&&onScroll(e.currentTarget.scrollTop,Date.now()<ownScroll.current,ruleRef.current?.getBoundingClientRect().bottom)}
        style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',paddingTop:navH,paddingBottom:84,boxSizing:'border-box'}}
        onClick={()=>menu&&setMenu(false)}
        onTouchStart={e=>{swipe.current={x:e.touches[0].clientX,y:e.touches[0].clientY,t:Date.now(),dir:null};}}
        onTouchMove={e=>{const s=swipe.current;if(!s||s.dir)return;const dx=e.touches[0].clientX-s.x,dy=e.touches[0].clientY-s.y;if(Math.abs(dx)>12||Math.abs(dy)>12)s.dir=Math.abs(dx)>Math.abs(dy)?'h':'v';}}
        onTouchEnd={e=>{const s=swipe.current;swipe.current=null;if(!s||s.dir!=='h')return;const dx=e.changedTouches[0].clientX-s.x;if(Math.abs(dx)<60&&Math.abs(dx)/Math.max(1,Date.now()-s.t)<0.35)return;onStep(dx<0?1:-1);}}>
      <div style={{maxWidth:760,margin:'0 auto',padding:'0 14px'}}>
      {/* The commentary's name above the chapter, where Read puts the version. */}
      <div style={{textAlign:'center',padding:'12px 0 2px',position:'relative'}}>
        <button type="button" aria-haspopup="menu" aria-expanded={menu} onClick={e=>{e.stopPropagation();setMenu(o=>!o);setMsg(null);}}
          style={{...small,display:'inline-flex',alignItems:'center',gap:6,background:menu?T.gF:'none',border:`1px solid ${menu?T.gD:'transparent'}`,borderRadius:12,color:T.gM,padding:'4px 10px',cursor:'pointer',maxWidth:'100%'}}>
          <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{cm.title}</span>
          <span aria-hidden="true" style={{fontSize:UL(8)}}>▾</span>
        </button>
        <div style={{fontFamily:FS,fontSize:UH(19),fontWeight:600,color:T.gT,letterSpacing:'0.06em',marginTop:4}}>{heading}</div>
        <div ref={ruleRef} style={{height:1,background:T.accentLine,marginTop:8}}/>
        {menu&&(
          <div role="menu" onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% - 4px)',left:0,right:0,zIndex:20,background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:10,boxShadow:'0 10px 30px rgba(0,0,0,0.4)',padding:6,textAlign:'left'}}>
            {list.map(c=>(
              <div key={c.id} style={{display:'flex',alignItems:'center',gap:6,borderRadius:8,background:c.id===cm.id?T.gF:'none'}}>
                <button type="button" role="menuitemradio" aria-checked={c.id===cm.id} onClick={()=>{onPick(c.id);setMenu(false);}}
                  style={{flex:1,minWidth:0,textAlign:'left',background:'none',border:'none',padding:'10px 10px',cursor:'pointer'}}>
                  <div style={{fontFamily:FB,fontSize:U(15),fontWeight:600,color:c.id===cm.id?T.gT:T.body,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.title}</div>
                  <div style={{...small,fontSize:UL(8),color:T.dim,marginTop:2,fontWeight:500}}>{c.builtin?'Included':'Imported · on this device'}</div>
                </button>
                <button type="button" aria-label={`About ${c.title}`} onClick={()=>showInfo(c)}
                  style={{width:34,height:34,flexShrink:0,background:'none',border:`1px solid ${T.bd}`,borderRadius:8,color:T.gM,fontFamily:FS,fontSize:U(13),cursor:'pointer'}}>i</button>
                {!c.builtin&&(
                  <button type="button" aria-label={`Delete ${c.title}`} onClick={()=>{if(window.confirm(`Delete “${c.title}” from this device?`))onDelete(c.id);}}
                    style={{width:34,height:34,flexShrink:0,marginRight:4,background:'none',border:`1px solid ${T.redTxt}55`,borderRadius:8,color:T.redTxt,fontSize:U(13),cursor:'pointer'}}>✕</button>
                )}
              </div>
            ))}
            <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,marginTop:6,padding:'10px 12px',border:`1px dashed ${T.gD}`,borderRadius:8,color:busy?T.dim:T.gT,cursor:busy?'default':'pointer',...small,fontSize:UL(9)}}>
              {busy?'Importing…':'＋ Import e-Sword commentary (.cmti)'}
              <input type="file" accept={Capacitor.getPlatform()==='ios'?undefined:'.cmti'} style={{display:'none'}} disabled={busy}
                onChange={e=>{const f=e.target.files?.[0];e.target.value='';pickFile(f);}}/>
            </label>
          </div>
        )}
        {msg&&<div style={{marginTop:8,fontFamily:FB,fontSize:U(13),color:msg.err?T.redTxt:T.gM}}>{msg.text}</div>}
      </div>
      <div style={{paddingTop:10}}>
        {rec===undefined&&<div style={{textAlign:'center',padding:'32px 0',color:T.dim,fontFamily:FB,fontStyle:'italic'}}>Loading…</div>}
        {rec===null&&(
          <div style={{textAlign:'center',padding:'36px 12px',color:T.dim,fontFamily:FB,fontStyle:'italic',fontSize:U(15),lineHeight:1.6}}>
            {cm.builtin?'The Treasury of Scripture Knowledge is being set up on this device. It will appear here in a moment.':`${cm.title} has no notes on ${heading}.`}
          </div>
        )}
        {rec&&<>
          {intro&&(
            <div style={card}>
              <button type="button" aria-expanded={introOpen} onClick={()=>setIntroOpen(o=>!o)}
                style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:T.bgSec,border:'none',padding:'10px 14px',cursor:'pointer',textAlign:'left'}}>
                <span style={{color:T.gM,display:'inline-flex',flexShrink:0}}><Caret open={introOpen} size={12}/></span>
                <span style={{...small,color:T.gT,flex:1}}>Introduction to {bookName(bk,lang)}</span>
              </button>
              {introOpen&&<div style={{padding:'12px 14px 8px'}}><CmLines text={intro} T={T} lang={lang} onRef={openPreview} px={px} family={readFont.family}/></div>}
            </div>
          )}
          {rec.o&&<div style={{...card,padding:'12px 14px 8px'}}><CmLines text={rec.o} T={T} lang={lang} onRef={openPreview} px={px} family={readFont.family}/></div>}
          {rec.v.map(([v,m,ve,ce])=>{
            const[main,back]=splitReciprocal(m);
            const open=recipOpen.has(v);
            const n=back?back.split('\n').length:0;
            const label=ce?`${v}–${ce}:${ve}`:ve?`${v}–${ve}`:`${v}`;
            const words=ve&&!ce?Array.from({length:ve-v+1},(_,k)=>texts[v+k]).filter(Boolean).join(' '):texts[v];
            return(
              <div key={`${v}-${ve||''}`} id={`cm-v-${v}`} style={{...card,border:`1px solid ${focus?.v===v?T.gD:T.bd}`,boxShadow:focus?.v===v?`0 0 0 1px ${T.gD}, 0 1px 8px var(--ac-sel-glow)`:'none',transition:'box-shadow .2s, border-color .2s'}}>
                <div role="button" tabIndex={0} aria-pressed={focus?.v===v} onClick={()=>onChoose(v)}
                  style={{display:'flex',gap:10,padding:'10px 14px',background:focus?.v===v?T.gF:T.bgSec,borderBottom:`1px solid ${T.bdS}`,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',transition:'background .2s'}}>
                  <span style={{fontFamily:FS,fontSize:Math.round(px*0.85),fontWeight:700,color:T.gT,flexShrink:0,minWidth:18,lineHeight:1.5}}>{label}</span>
                  <span style={{fontFamily:readFont.family,fontSize:px,color:T.mut,lineHeight:1.5,fontStyle:words?'normal':'italic'}}>{words||'…'}</span>
                </div>
                <div style={{padding:'10px 14px 6px'}}>
                  {main?<CmLines text={main} T={T} lang={lang} onRef={openPreview} px={px} family={readFont.family}/>
                    :<div style={{fontFamily:readFont.family,fontSize:px,fontStyle:'italic',color:T.dim,marginBottom:6}}>No cross-references of its own.</div>}
                  {n>0&&(
                    <div style={{borderTop:`1px solid ${T.bdS}`,marginTop:4,paddingTop:4}}>
                      <button type="button" aria-expanded={open} onClick={()=>setRecipOpen(s=>{const x=new Set(s);x.has(v)?x.delete(v):x.add(v);return x;})}
                        style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:'none',border:'none',padding:'6px 0',cursor:'pointer',textAlign:'left'}}>
                        <span style={{color:T.gM,display:'inline-flex',flexShrink:0}}><Caret open={open} size={11}/></span>
                        <span style={{...small,color:T.gM}}>Reciprocal</span>
                        <span style={{fontFamily:FS,fontSize:UL(9),color:T.dim}}>{n}</span>
                      </button>
                      {open&&<div style={{paddingTop:2}}><CmLines text={back} T={T} lang={lang} onRef={openPreview} px={Math.round(px*0.92)} family={readFont.family} color={T.mut}/></div>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </>}
      </div>
      </div>
      </div>

      {/* Slides away with the nav in full screen, as Read's bottom bar does. */}
      <div className="bottom-nav-safe" style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,padding:'1px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',transform:fs?'translateY(100%)':'none',transition:'transform .18s ease'}}>
        <button type="button" onClick={()=>onStep(-1)} disabled={book===1&&ch===1} style={{...navBtn,opacity:book===1&&ch===1?0.4:1}}>‹ Prev</button>
        {/* The book, chapter and verse picker, as Parallel's is. */}
        <button type="button" onClick={onNav} style={{background:'none',border:'none',color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.2em',textTransform:'uppercase',fontWeight:500,cursor:'pointer',padding:'8px 8px'}}>{shortBook(bookName(bk,lang))} {ch}</button>
        <button type="button" onClick={()=>onStep(1)} disabled={book===66&&ch===(bk?.v?.length||1)} style={{...navBtn,opacity:book===66&&ch===(bk?.v?.length||1)?0.4:1}}>Next ›</button>
      </div>

      {/* A reference, read where it is tapped. The same card as the Strong's
          verse preview, taking a range. */}
      {preview&&(
        <VersePreview T={T} title={cmRefLabel(preview.ref,lang,true)} sub={verLabel} readFont={readFont}
          loading={preview.rows===null}
          rows={(preview.rows||[]).map(r=>({key:`${r.c}:${r.v}`,label:r.c!==preview.ref.c?`${r.c}:${r.v}`:r.v,html:verseHtml(preview.ref.b,r.c,r.v,r.text)}))}
          onClose={()=>setPreview(null)} onGo={()=>{const r=preview.ref;setPreview(null);onGo(r);}}/>
      )}

      {info&&(
        <div onClick={()=>setInfo(null)} style={{position:'fixed',inset:0,zIndex:250,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px 20px',animation:'fadeIn .15s ease both'}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg,borderRadius:16,width:'100%',maxWidth:520,maxHeight:'80vh',display:'flex',flexDirection:'column',boxShadow:'0 8px 40px rgba(0,0,0,0.6)'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,padding:'18px 20px 12px',flexShrink:0}}>
              <SheetBackBtn onClick={()=>setInfo(null)} T={T}/>
              <span style={{fontFamily:FS,fontSize:U(14),letterSpacing:'0.08em',color:T.gT,fontWeight:600,flex:1,textAlign:'center'}}>{info.c.title}</span>
              <span style={{width:27,flexShrink:0}}/>
            </div>
            <div style={{overflowY:'auto',padding:'0 20px 22px',flex:1,minHeight:0}}>
              {info.notice&&(
                <div style={{border:`1px solid ${T.gD}`,background:T.gF,borderRadius:10,padding:'12px 14px',marginBottom:14}}>
                  {info.notice.map((p,i)=><p key={i} style={{fontFamily:FB,fontSize:U(13),color:T.mut,lineHeight:1.55,margin:i?'8px 0 0':0}}>{p}</p>)}
                  <p style={{fontFamily:FB,fontSize:U(13),color:T.mut,lineHeight:1.55,margin:'8px 0 0'}}>This edition is offered in an open format, as the licence asks, at <span style={{color:T.gT,overflowWrap:'anywhere'}}>brockigordon1611.github.io/Scriptorium/bundled/tske.json</span></p>
                </div>
              )}
              {info.info?<CmLines text={info.info} T={T} lang={lang} onRef={r=>{setInfo(null);openPreview(r);}} px={Math.max(14,Math.round(px*0.85))} color={T.mut}/>
                :!info.notice&&<div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(14)}}>This commentary came with no description.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The text size for everything laid out like Commentaries -- Commentaries,
// Parallel, Bookmarks, the Strong's entry and the verse popups. Four-fifths
// of Scripture Size (25px at the default of 31), so moving between Read and
// these doesn't mean changing the setting; 60% was a jump down from Read.
const cmPx=size=>Math.max(14,Math.min(48,Math.round(size*0.8)));

// A Strong's entry laid out as Commentaries lays out a verse: the number and
// what it is on one line over the gold rule, the word as a card holding its
// definition, and each English rendering as a card that opens to its verses.
// The popup over Read and the Strong's Concordance page both draw it, so the
// two cannot drift apart.
function StrongsEntry({T,num,entry,groupList,totalCount,expanded,onToggle,onRef,derivation,readFont,lang,lead,trail,reserveRight=0}){
  const px=cmPx(readFont.size),fam=readFont.family;
  const card={background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:10,overflow:'hidden'};
  // The small caps grow with the entry too, or a count sits at 9px beside
  // a 28px word.
  const small={fontFamily:FS,fontSize:Math.min(14,Math.max(9,Math.round(px*0.46))),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600};
  const langName=entry?.language==='hebrew'?'Hebrew':entry?.language==='greek'?'Greek':null;
  // One block, not a fragment: the popup scrolls a flex column, and loose
  // cards in it shrank to nothing instead of scrolling.
  return(<div style={{flexShrink:0}}>
    {/* The number, and under it what it is, from the left and level with the
        close button. */}
    <div style={{display:'flex',alignItems:'center',gap:10,minHeight:34,paddingRight:reserveRight,minWidth:0,flexShrink:0}}>
      {lead}
      <div style={{flex:1,minWidth:0,display:'flex',flexDirection:'column',gap:6}}>
        {/* Sized with the entry, off Scripture Size: at a fixed 19px the
            number sat smaller than the definition beneath it. */}
        <span style={{fontFamily:FS,fontSize:Math.round(px*1.04),letterSpacing:'0.06em',color:T.gT,fontWeight:600,lineHeight:1}}>{num}</span>
        <span style={{...small,fontSize:Math.min(13,Math.round(px*0.48)),letterSpacing:'0.1em',color:T.gM,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0,lineHeight:1.2}}>
          {/* The number already says Strong's; at this size the full line no
              longer fit beside the close button. */}
          {[langName,totalCount>0?`${totalCount.toLocaleString()} in the KJV`:null].filter(Boolean).join(' · ')||"Strong's"}
        </span>
      </div>
      {trail}
    </div>
    <div style={{height:14,flexShrink:0}}/>
    {!entry?<div style={{textAlign:'center',padding:20,color:T.dim,fontFamily:FB}}>Loading…</div>:<>
      {/* The word: the original and its transliteration in the band, then the
          definition -- larger than the rest, being what the reader came for --
          and the derivation under a hairline. */}
      <div style={card}>
        <div style={{display:'flex',alignItems:'baseline',flexWrap:'wrap',gap:'4px 12px',padding:'10px 14px',background:T.bgSec,borderBottom:`1px solid ${T.bdS}`}}>
          <span style={{fontFamily:fam,fontSize:Math.round(px*0.92),color:T.gT,lineHeight:1.2}}>{entry.original_word}</span>
          <span style={{fontFamily:fam,fontSize:px,color:T.mut,fontStyle:'italic'}}>{entry.transliteration}{entry.pronunciation?` (${entry.pronunciation})`:''}</span>
        </div>
        <div style={{padding:'12px 14px 10px'}}>
          <div style={{fontFamily:fam,fontSize:Math.round(px*1.08),color:T.body,lineHeight:1.45}}>{String(entry.short_def||'').trim()}</div>
          {derivation&&<div style={{fontFamily:fam,fontSize:Math.round(px*1.05),color:T.mut,lineHeight:1.5,borderTop:`1px solid ${T.bdS}`,marginTop:10,paddingTop:8}}>{derivation}</div>}
        </div>
      </div>
      {groupList.length>0&&<div style={{...small,color:T.gM,margin:'16px 2px 7px'}}>KJV usage</div>}
      {/* Each English rendering is a card, folded until tapped, like a verse's
          Reciprocal list. The word is in the reading font: Cinzel has no lower
          case, and "God", "god" and "LORD" are different words. */}
      {groupList.map(([key,{word,refs}])=>{
        const open=expanded.has(key);
        const times=[...refs.values()].reduce((s,c)=>s+c,0);
        // Where the KJV has no English tied to the word, the rendering is
        // STEPBible's gloss, whose brackets mean opposite things. Square ones
        // ("[are] to") are words supplied for the English and not in the
        // original -- what the KJV prints in italics, so they are italic here
        // too. Angle ones ("<to>", "<obj.>") are in the original but not in the
        // translation; they are set dim instead, so italics keep the one
        // meaning, and a rendering made only of them says it is not translated.
        const parts=String(word||'').split(/(<[^>]*>|\[[^\]]*\])/).filter(Boolean);
        const implied=parts.some(p=>/^<[^>]*>$/.test(p))&&parts.every(p=>/^<[^>]*>$/.test(p)||!p.trim());
        const shown=parts.map((p,i)=>/^<[^>]*>$/.test(p)?<span key={i} style={{color:T.dim}}>{p.slice(1,-1)}</span>
          :/^\[[^\]]*\]$/.test(p)?<i key={i}>{p.slice(1,-1)}</i>:p);
        const refArr=[...refs.entries()].map(([r,cnt])=>{const[bn,ch,vs]=r.split('|').map(Number);return{bn,ch,vs,cnt};}).sort((a,b)=>a.bn-b.bn||a.ch-b.ch||a.vs-b.vs);
        return(
          <div key={key} style={card}>
            <div role="button" tabIndex={0} aria-expanded={open} onClick={()=>onToggle(key)}
              style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:T.bgSec,borderBottom:open?`1px solid ${T.bdS}`:'none',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none'}}>
              <span style={{fontFamily:fam,fontSize:Math.round(px*0.92),fontWeight:700,color:T.gT,lineHeight:1.2}}>{shown}</span>
              <span style={{...small,color:T.dim,flex:1}}>{times}× · {refs.size} {refs.size===1?'verse':'verses'}{implied?' · not translated':''}</span>
              <span style={{color:T.gM,display:'inline-flex',flexShrink:0}}><Caret open={open} size={12}/></span>
            </div>
            {open&&(
              <div style={{padding:'10px 14px 8px',fontFamily:fam,fontSize:Math.round(px*0.92),lineHeight:1.6,color:T.body}}>
                {refArr.map(({bn,ch,vs,cnt})=>(
                  <span key={`${bn}-${ch}-${vs}`} style={{display:'inline-block',marginRight:16,marginBottom:4,whiteSpace:'nowrap'}}>
                    <span role="button" tabIndex={0} onClick={e=>{e.stopPropagation();onRef(bn,ch,vs);}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onRef(bn,ch,vs);}}}
                      style={{color:T.gT,textDecoration:'underline dotted',textDecorationColor:T.gD,textUnderlineOffset:3,cursor:'pointer'}}>
                      {shortBook(bookName(BIBLE[bn-1],lang))} {ch}:{vs}
                    </span>
                    {cnt>1&&<span style={{color:T.dim}}> ×{cnt}</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>}
  </div>);
}

// The frame the popups over the page share: dimmed and blurred behind, the
// card held inside the screen's safe area, a fixed head and foot, and only
// the middle scrolling. Sized by vh, a long verse ran the card off the
// screen on the phone; held to the overlay's own height, it cannot.
function PopFrame({T,onClose,head,foot,children,maxWidth=460,zIndex=250}){
  return(
    <div onClick={onClose} style={{position:'fixed',inset:0,zIndex,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',boxSizing:'border-box',
      padding:'max(20px, calc(env(safe-area-inset-top) + 12px)) 16px max(20px, calc(env(safe-area-inset-bottom) + 12px))',animation:'fadeIn .15s ease both'}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg,border:`1px solid ${T.bdA}`,borderRadius:16,width:'100%',maxWidth,maxHeight:'100%',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 8px 40px rgba(0,0,0,0.6)'}}>
        <div style={{height:3,background:T.accentLine,flexShrink:0}}/>
        <div style={{flexShrink:0}}>{head}</div>
        <div style={{flex:1,minHeight:0,overflowY:'auto',overscrollBehavior:'contain',WebkitOverflowScrolling:'touch',padding:'12px 16px 4px'}}>{children}</div>
        {foot&&<div style={{flexShrink:0,padding:'12px 16px 16px'}}>{foot}</div>}
      </div>
    </div>
  );
}
// The heading the popups share, as Commentaries heads a chapter: a small line
// saying what it is over the title, and the gold rule.
function PopHead({T,sub,title,onBack}){
  return(
    <div style={{position:'relative',padding:'14px 16px 0',textAlign:'center'}}>
      {onBack&&<div style={{position:'absolute',left:16,top:14}}><SheetBackBtn onClick={onBack} T={T}/></div>}
      <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600,color:T.gM,minHeight:12,padding:'0 44px'}}>{sub}</div>
      <div style={{fontFamily:FS,fontSize:UH(17),fontWeight:600,color:T.gT,letterSpacing:'0.06em',marginTop:3,padding:'0 44px'}}>{title}</div>
      <div style={{height:1,background:T.accentLine,marginTop:10}}/>
    </div>
  );
}
// Verses as a card, a row each: the number in gold, the words beside it.
function VerseRows({T,rows,readFont,size}){
  const px=cmPx(readFont.size),fs=size||Math.round(px*1.04);
  return(
    <div style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,overflow:'hidden'}}>
      {rows.map((r,i)=>(
        <div key={r.key} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 14px',borderTop:i?`1px solid ${T.bdS}`:'none'}}>
          <span style={{fontFamily:FS,fontSize:Math.round(px*0.85),fontWeight:700,color:T.gT,flexShrink:0,minWidth:18,lineHeight:`${Math.round(fs*1.5)}px`}}>{r.label}</span>
          <span style={{fontFamily:readFont.family,fontSize:fs,color:T.body,lineHeight:1.5,minWidth:0,overflowWrap:'anywhere'}} dangerouslySetInnerHTML={{__html:r.html}}/>
        </div>
      ))}
    </div>
  );
}
// A passage read where its reference was tapped -- a Strong's occurrence or a
// commentary's cross-reference.
function VersePreview({T,title,sub,rows,loading,emptyText,onClose,onGo,readFont}){
  const note=t=><div style={{color:T.dim,fontFamily:FB,fontStyle:'italic',fontSize:U(14),textAlign:'center',padding:'14px 0'}}>{t}</div>;
  return(
    <PopFrame T={T} onClose={onClose}
      head={<PopHead T={T} sub={sub} title={title} onBack={onClose}/>}
      foot={<button type="button" onClick={onGo}
        style={{width:'100%',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,cursor:'pointer',fontFamily:FS,fontSize:U(12),letterSpacing:'0.1em',textTransform:'uppercase',padding:'12px 0',fontWeight:600}}>Go to passage</button>}>
      {loading?note('Loading…'):rows.length===0?note(emptyText||'This passage isn’t in the version you’re reading.'):<VerseRows T={T} rows={rows} readFont={readFont}/>}
      <div style={{height:8}}/>
    </PopFrame>
  );
}
// Saving a bookmark, laid out as Commentaries is: the reference as the
// heading, the verses being saved as a card, then the note and the category.
function BookmarkDialog({T,d,rows,readFont,categories,canCategorize,onChange,onSave,onCancel}){
  const px=cmPx(readFont.size);
  const small={fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600,color:T.gM,margin:'16px 2px 7px'};
  const chip=(on,color)=>({background:on?(color?color+'28':T.gF):'none',border:`1.5px solid ${on?(color||T.gD):T.bd}`,borderRadius:14,color:on?(color||T.gT):T.dim,fontFamily:FS,fontSize:U(11),padding:'8px 14px',cursor:'pointer',fontWeight:on?600:400});
  // 16px at least, or iOS zooms the page to the field.
  const field={width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:8,color:T.body,fontFamily:readFont.family,fontSize:Math.max(16,px),padding:'10px 12px',outline:'none',lineHeight:1.5};
  const btn=primary=>({flex:primary?1:'none',background:primary?T.gF:'none',border:`1px solid ${primary?T.gD:T.bd}`,borderRadius:8,color:primary?T.gT:T.dim,cursor:d.busy?'default':'pointer',fontFamily:FS,fontSize:U(12),letterSpacing:'0.1em',textTransform:'uppercase',padding:'12px 18px',fontWeight:600,opacity:d.busy&&primary?0.6:1});
  return(
    <PopFrame T={T} onClose={onCancel} zIndex={500}
      head={<PopHead T={T} sub="Save bookmark" title={d.ref} onBack={onCancel}/>}
      foot={<div style={{display:'flex',gap:8}}>
        <button type="button" onClick={onCancel} style={btn(false)}>Cancel</button>
        <button type="button" onClick={onSave} disabled={d.busy} style={btn(true)}>{d.busy?'Saving…':'Save'}</button>
      </div>}>
      {rows.length>0&&<VerseRows T={T} rows={rows} readFont={readFont} size={px}/>}
      <div style={{...small,marginTop:rows.length?16:4}}>Note</div>
      <textarea value={d.note} onChange={e=>onChange({note:e.target.value})} rows={3} placeholder="Anything worth remembering about this passage…" style={{...field,resize:'vertical'}}/>
      {canCategorize&&<>
        <div style={small}>Category</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          <button type="button" onClick={()=>onChange({cat:''})} style={chip(!d.cat)}>None</button>
          {categories.map(c=><button key={c.id} type="button" onClick={()=>onChange({cat:c.id})} style={chip(d.cat===c.id,c.color)}>{c.name}</button>)}
          <button type="button" onClick={()=>onChange({cat:'__new'})} style={chip(d.cat==='__new')}>＋ New</button>
        </div>
        {d.cat==='__new'&&<input value={d.newCat} onChange={e=>onChange({newCat:e.target.value})} placeholder="New category name" autoFocus style={{...field,marginTop:8}}/>}
      </>}
      <div style={{height:8}}/>
    </PopFrame>
  );
}

// Every highlight, grouped by colour like bookmark categories, filtered by
// colour and by version. Each row shows the verse's words in the version it was
// highlighted in: highlights are about the text, where bookmarks are about the
// place. The words load a chapter at a time, four at once, for what is shown.
function HighlightsPanel({T,dark,highlights,versions,onOpen,onClose,onBack,navH,isClosing}){
  const[colorF,setColorF]=useState('all');
  const[verF,setVerF]=useState('all');
  const[verMenu,setVerMenu]=useState(false);
  const[texts,setTexts]=useState({});
  const asked=useRef(new Set()),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;},[]);
  const verIds=[...new Set(highlights.map(h=>h.version_id))];
  const verLabel=id=>versions.find(v=>v.id===id)?.label||(String(id).startsWith('user-')?'Imported':String(id).toUpperCase());
  const shown=highlights
    .filter(h=>(colorF==='all'||h.color===colorF)&&(verF==='all'||h.version_id===verF))
    .slice().sort((a,b)=>a.book_num-b.book_num||a.chapter-b.chapter||a.verse-b.verse||String(a.version_id).localeCompare(String(b.version_id)));
  const need=[...new Set(shown.map(h=>`${h.version_id}|${h.book_num}|${h.chapter}`))].filter(k=>!asked.current.has(k));
  useEffect(()=>{
    if(!need.length)return;
    need.forEach(k=>asked.current.add(k));
    let i=0;
    const work=async()=>{
      while(alive.current&&i<need.length){
        const k=need[i++];const[vid,b,c]=k.split('|');
        let rows=[];try{rows=await dbGetChapter(vid,+b,+c);}catch{}
        if(!alive.current)return;
        setTexts(t=>{const n={...t,[`${k}|loaded`]:true};for(const r of rows)n[`${k}|${r.verse}`]=String(r.text||'').replace(/<[^>]+>/g,'');return n;});
      }
    };
    Promise.all([work(),work(),work(),work()]);
  },[need.join(',')]);
  const chip=on=>({background:on?T.gF:'none',border:`1px solid ${on?T.gD:T.bd}`,borderRadius:12,color:on?T.gT:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.06em',padding:'6px 12px',cursor:'pointer',fontWeight:on?600:400});
  return(
    <Modal title="Highlights" onClose={onClose} onBack={onBack} T={T} topSheet={navH} isClosing={isClosing} fade="soft" footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {highlights.length===0?(
        <div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15)}}>No highlights yet. In Reading Mode, tap a verse, then the colour button beside its reference.</div>
      ):(<>
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:14}}>
          <button type="button" onClick={()=>setColorF('all')} style={chip(colorF==='all')}>All</button>
          {HL_COLORS.map(c=>(
            <button key={c.key} type="button" aria-label={`Show ${c.label.toLowerCase()} only`} aria-pressed={colorF===c.key} onClick={()=>setColorF(f=>f===c.key?'all':c.key)}
              style={{width:U(26),height:U(26),borderRadius:'50%',background:c.dot,border:`2px solid ${colorF===c.key?T.gT:'transparent'}`,opacity:colorF==='all'||colorF===c.key?1:0.35,padding:0,cursor:'pointer',boxSizing:'border-box',flexShrink:0}}/>
          ))}
          {/* By version: a small dropdown at the end of the colour row, listing
              only the versions that hold highlights. Not a native select --
              below 16px iOS zooms the page to it, and 16px is too large here. */}
          {verIds.length>0&&(
            <div style={{marginLeft:'auto',position:'relative'}}>
              <button type="button" aria-haspopup="listbox" aria-expanded={verMenu} onClick={()=>setVerMenu(o=>!o)}
                style={{...chip(verF!=='all'),display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}}>
                {verF==='all'?'Version':verLabel(verF)}<span aria-hidden="true" style={{fontSize:UL(9),lineHeight:1}}>▾</span>
              </button>
              {verMenu&&(
                <div role="listbox" style={{position:'absolute',right:0,top:'calc(100% + 6px)',zIndex:5,background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:8,boxShadow:'0 8px 24px rgba(0,0,0,0.35)',padding:4,minWidth:'100%',display:'flex',flexDirection:'column'}}>
                  {[['all','All versions'],...verIds.map(id=>[id,verLabel(id)])].map(([id,l])=>(
                    <button key={id} type="button" role="option" aria-selected={verF===id} onClick={()=>{setVerF(id);setVerMenu(false);}}
                      style={{textAlign:'left',background:verF===id?T.gF:'none',border:'none',borderRadius:6,color:verF===id?T.gT:T.mut,fontFamily:FS,fontSize:U(11),letterSpacing:'0.06em',padding:'9px 12px',cursor:'pointer',whiteSpace:'nowrap'}}>{l}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {shown.length===0&&<div style={{textAlign:'center',padding:'24px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15)}}>No highlights match these filters.</div>}
        {HL_COLORS.map(c=>{
          const rows=shown.filter(h=>h.color===c.key);
          if(!rows.length)return null;
          return(
            <div key={c.key} style={{border:`1px solid ${c.dot}55`,background:c.dot+'0a',borderRadius:10,marginBottom:10,overflow:'hidden'}}>
              <div style={{display:'flex',alignItems:'center',gap:8,padding:'10px 12px',borderBottom:`1px solid ${c.dot}33`}}>
                <span style={{width:10,height:10,borderRadius:'50%',background:c.dot,flexShrink:0}}/>
                <span style={{fontFamily:FS,fontSize:U(12),fontWeight:600,color:T.gT,letterSpacing:'0.06em',flex:1,textTransform:'uppercase'}}>{c.label}</span>
                <span style={{fontFamily:FS,fontSize:UL(10),color:T.dim}}>{rows.length}</span>
              </div>
              {rows.map((h,i)=>{
                const bk=BIBLE.find(b=>b.n===h.book_num),ck=`${h.version_id}|${h.book_num}|${h.chapter}`,words=texts[`${ck}|${h.verse}`];
                return(
                  <div key={`${ck}|${h.verse}`} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderTop:i?`1px solid ${c.dot}22`:'none'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}>{bookName(bk,versions.find(v=>v.id===h.version_id)?.lang||versionLang(h.version_id))||'?'} {h.chapter}:{h.verse} <span style={{color:T.gM,fontWeight:400,fontSize:U(11)}}>{verLabel(h.version_id)}</span></div>
                      <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,lineHeight:1.5,marginTop:2,display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>
                        {words!=null
                          ?<span style={{background:dark?c.dark:c.light,borderRadius:2,WebkitBoxDecorationBreak:'clone',boxDecorationBreak:'clone'}}>{words}</span>
                          :<span style={{fontStyle:'italic',color:T.dim}}>{texts[`${ck}|loaded`]?'Text not on this device':'…'}</span>}
                      </div>
                    </div>
                    <button className="s-btn s-ghost" onClick={()=>onOpen(h)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'8px 14px',fontWeight:500,flexShrink:0}}>Open</button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </>)}
    </Modal>
  );
}

function RecentsPanel({T,recents,onOpen,onClose,onBack,versions,navH,isClosing}){
  return(
    <Modal title="Recent Passages" onClose={onClose} onBack={onBack} T={T} topSheet={navH} isClosing={isClosing} fade="soft" footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {recents.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15)}}>No recent passages yet. Browse chapters in Reading Mode.</div>}
      {recents.map(r=>{
        const bk=BIBLE.find(b=>b.n===r.book_num);const ver=versions.find(v=>v.id===r.version_id);
        return(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{flex:1}}>
              <span style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}>{bk?.name} {r.chapter}</span>
              <span style={{fontFamily:FB,fontSize:U(13),color:T.dim,marginLeft:10}}>{ver?.label||(r.version_id||'').toUpperCase()}</span>
            </div>
            <div style={{fontFamily:FB,fontSize:U(12),color:T.dim}}>{fmtDate(r.visited_at)}</div>
            <button className="s-btn s-ghost" onClick={()=>onOpen(r)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'5px 10px',fontWeight:500}}>Read</button>
          </div>
        );
      })}
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════
//  VERSIONS MODAL  (manage + upload — unified)
// ══════════════════════════════════════════════════════════
function VersionsModal({data,onSave,onClose,T,dlStates={},onDownload,onDeleteLocal,navH,onBack,isClosing,user}){
  const[vers,setVers]=useState(clone(data.versions));
  const builtinAvail=PUBLIC_VERSIONS.filter(pv=>!vers.find(v=>v.id===pv.id));

  // Local availability for user-imported versions: null=checking, true=on device, false=not on device
  const[localAvail,setLocalAvail]=useState({});
  useEffect(()=>{
    vers.filter(v=>!PUBLIC_VERSIONS.some(pv=>pv.id===v.id)).forEach(v=>{
      setLocalAvail(a=>({...a,[v.id]:null}));
      idbIsDownloaded(v.id).then(ok=>setLocalAvail(a=>({...a,[v.id]:ok})));
    });
  },[]);

  // Import form state
  const[importLabel,setImportLabel]=useState('');
  const[importLang,setImportLang]=useState('ES');
  const[importFile,setImportFile]=useState(null);
  const[importing,setImporting]=useState(null); // null | 'new' | versionId
  const[importProg,setImportProg]=useState([0,0]);
  const[importErr,setImportErr]=useState('');
  const[importNote,setImportNote]=useState('');
  // Imports register the moment they finish, before Save, so one imported and
  // taken off again in the same sitting has to be remembered to be deleted.
  const importedHere=useRef(new Map()); // id -> label

  function remove(id){setVers(v=>v.filter(x=>x.id!==id));}
  function addBuiltin(pv){setVers(v=>[...v,{id:pv.id,label:pv.label,lang:pv.lang,isRef:false}]);}
  function doSave(){let v=[...vers];if(!v.some(x=>x.isRef)&&v.length)v[0]={...v[0],isRef:true};onSave(v,[...importedHere.current].map(([id,label])=>({id,label})));}

  async function doImport(){
    if(!importFile||!importLabel.trim())return;
    // Same name and language as one already imported: replace it, don't add a twin.
    const match=findOwnImport(vers,importLabel,importLang,user?.id);
    setImportErr('');setImportNote('');setImporting(match?match.id:'new');setImportProg([0,0]);
    try{
      const v=await importBblxFile({file:importFile,label:match?match.label:importLabel.trim(),lang:match?match.lang:importLang,userId:user?.id,existingVersionId:match?.id,onProgress:(d,t)=>setImportProg([d,t])});
      if(!match){setVers(vs=>[...vs,v]);importedHere.current.set(v.id,v.label);}
      setLocalAvail(a=>({...a,[v.id]:true}));
      if(match)setImportNote(`Replaced your existing ${match.label}.`);
      setImportLabel('');setImportFile(null);
    }catch(e){setImportErr(e.message);}
    finally{setImporting(null);}
  }

  async function doReImport(vId,file){
    const v=vers.find(x=>x.id===vId);
    setImportErr('');setImporting(vId);setImportProg([0,0]);
    try{
      await importBblxFile({file,label:v?.label||'',lang:v?.lang||'EN',userId:user?.id,existingVersionId:vId,onProgress:(d,t)=>setImportProg([d,t])});
      setLocalAvail(a=>({...a,[vId]:true}));
    }catch(e){setImportErr(e.message);}
    finally{setImporting(null);}
  }

  const inputStyle={width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(14),padding:'9px 11px',outline:'none',marginBottom:8};

  return(
    <Modal title="Bible Versions" onClose={onClose} onBack={onBack} wide T={T} topSheet={navH} isClosing={isClosing} footer={<><SBtn ch="Cancel" onClick={onClose} T={T}/><PBtn ch="Save" onClick={doSave} T={T}/></>}>
      {/* Current versions */}
      {vers.length===0&&<div style={{padding:'18px 0',textAlign:'center',fontFamily:FB,fontSize:U(15),color:T.dim}}>No versions added yet.</div>}
      {vers.map((v,i)=>{
        const dl=dlStates[v.id]||{};
        const isBuiltin=PUBLIC_VERSIONS.some(pv=>pv.id===v.id);
        const avail=localAvail[v.id];
        const isReImporting=importing===v.id;
        return(
          <div key={v.id} style={{padding:'11px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:U(16),color:T.body,fontWeight:500}}>{v.label}</div>
                <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:2,letterSpacing:'0.08em'}}>{isBuiltin?v.id:v.label.toLowerCase()} · {v.lang}{i===0?' · default':''}</div>
              </div>
              {/* Built-in offline controls */}
              {isBuiltin&&onDownload&&(
                dl.downloading?<span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,whiteSpace:'nowrap'}}>{dl.total>0?`${Math.round((dl.progress/dl.total)*100)}%`:'…'}</span>
                :dl.downloaded?<button onClick={()=>onDeleteLocal(v.id)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:'#62c484',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>✓ Offline</button>
                :<button onClick={()=>onDownload(v.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>↓ Offline</button>
              )}
              {/* User-imported device status */}
              {!isBuiltin&&(
                isReImporting
                  ?<span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,whiteSpace:'nowrap'}}>{importProg[1]>0?`${Math.round((importProg[0]/importProg[1])*100)}%`:'…'}</span>
                  :avail===true?<span style={{fontFamily:FS,fontSize:UL(9),color:'#62c484',whiteSpace:'nowrap'}}>✓ On device</span>
                  :avail===false?<label style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                    ⚠︎ Re-import<input type="file" accept=".bblx,.bbli,.SQLite3,.sqlite3,.db" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f)doReImport(v.id,f);e.target.value='';}}/>
                  </label>
                  :<span style={{fontFamily:FS,fontSize:UL(9),color:T.dim}}>…</span>
              )}
              <button onClick={()=>remove(v.id)} disabled={vers.length===1} style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,padding:'5px 11px',fontSize:U(13),cursor:vers.length===1?'default':'pointer',opacity:vers.length===1?0.4:1}}>✕</button>
            </div>
            {isBuiltin&&dl.downloading&&dl.total>0&&(
              <div style={{marginTop:6,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${Math.round((dl.progress/dl.total)*100)}%`,background:T.gT,borderRadius:1,transition:'width .2s'}}/>
              </div>
            )}
            {dl.err&&<div style={{fontFamily:FB,fontSize:U(12),color:T.redTxt,marginTop:4}}>{dl.err}</div>}
          </div>
        );
      })}
      {/* Add built-in versions */}
      {builtinAvail.length>0&&(
        <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
          <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>BUILT-IN VERSIONS</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {builtinAvail.map(pv=>(
              <button key={pv.id} onClick={()=>addBuiltin(pv)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FB,fontSize:U(15),padding:'8px 16px',cursor:'pointer'}}>＋ {pv.label}</button>
            ))}
          </div>
        </div>
      )}
      {/* Import your own Bible */}
      <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
        <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>IMPORT YOUR OWN BIBLE</div>
        <div style={{fontFamily:FB,fontSize:U(12),color:T.dim,lineHeight:1.6,marginBottom:12}}>Import a Bible you legally own from e-Sword (.bblx) or MyBible (.SQLite3). The text stays on your device only — never uploaded.</div>
        <input value={importLabel} onChange={e=>setImportLabel(e.target.value)} placeholder="Label (e.g. RVR1960)" style={inputStyle}/>
        <select value={importLang} onChange={e=>setImportLang(e.target.value)} style={{...inputStyle,marginBottom:8}}>
          <option value="EN">English</option>
          <option value="ES">Spanish</option>
          <option value="PT">Portuguese</option>
          <option value="FR">French</option>
          <option value="DE">German</option>
          <option value="IT">Italian</option>
          <option value="ZH">Chinese</option>
          <option value="AR">Arabic</option>
          <option value="RU">Russian</option>
          <option value="OTHER">Other</option>
        </select>
        <label style={{display:'block',background:T.bgIn,border:`1px dashed ${T.bd}`,borderRadius:6,padding:'10px 14px',cursor:'pointer',fontFamily:FB,fontSize:U(13),color:importFile?T.body:T.dim,marginBottom:8,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
          {importFile?importFile.name:'Choose .bblx, .bbli, or .SQLite3 file…'}
          <input type="file" accept=".bblx,.bbli,.SQLite3,.sqlite3,.db" style={{display:'none'}} onChange={e=>{setImportFile(e.target.files?.[0]||null);e.target.value='';}}/>
        </label>
        {importing==='new'?(
          <div style={{fontFamily:FB,fontSize:U(13),color:T.gM,padding:'8px 0'}}>
            Importing…{importProg[1]>0?` ${Math.round((importProg[0]/importProg[1])*100)}%`:''}
            <div style={{marginTop:6,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
              <div style={{height:'100%',width:importProg[1]>0?`${Math.round((importProg[0]/importProg[1])*100)}%`:'0%',background:T.gT,borderRadius:1,transition:'width .3s'}}/>
            </div>
          </div>
        ):(
          <button onClick={doImport} disabled={!importFile||!importLabel.trim()} style={{width:'100%',background:(!importFile||!importLabel.trim())?T.bgIn:T.gF,border:`1px solid ${(!importFile||!importLabel.trim())?T.bd:T.gD}`,borderRadius:6,color:(!importFile||!importLabel.trim())?T.dim:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'10px 0',cursor:(!importFile||!importLabel.trim())?'default':'pointer',fontWeight:600,transition:'all .15s'}}>
            IMPORT
          </button>
        )}
        {importErr&&<div style={{fontFamily:FB,fontSize:U(12),color:T.redTxt,marginTop:6}}>{importErr}</div>}
        {importNote&&<div style={{fontFamily:FB,fontSize:U(12),color:T.greenTxt,marginTop:6}}>{importNote}</div>}
      </div>
      {/* Request a new version */}
      <div style={{marginTop:20,paddingTop:16}}>
        <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>REQUEST A VERSION</div>
        <div style={{fontFamily:FB,fontSize:U(13),color:T.dim,lineHeight:1.7}}>To request a new Bible version or translation to be added to Scriptorium, please contact the app creator.</div>
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
  const refLang=(versions.find(v=>v.isRef)||versions[0])?.lang||'EN';
  const displayRef=parsed?`${bookName(BIBLE[parsed.bookNum-1],refLang)} ${parsed.chapter}:${parsed.verse}`:entry.reference;
  return(
    <div id={`card-${entry.id}`} className={`entry-card hov-card fade-up${pulse?' pulse':''}`}
      style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:12,overflow:'hidden',boxShadow:`0 2px 8px rgba(0,0,0,${dark?.3:.06})`,animationDelay:`${delay}s`}}>
      <div style={{height:2,background:`linear-gradient(90deg, ${typeColor.bd}, ${typeColor.bd}60, transparent)`}}/>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'11px 18px',borderBottom:`1px solid ${T.bd}`}}>
        <span dangerouslySetInnerHTML={{__html:hl(displayRef,q)}} style={{fontFamily:FS,fontSize:U(14.5),fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}/>
        {entry.issueLabel&&<Badge type={entry.issueType} label={entry.issueLabel} dark={dark}/>}
        <div style={{marginLeft:'auto',display:'flex',gap:5}}>
          {parsed&&onRead&&<button className="s-btn s-ghost" onClick={()=>onRead(parsed)} title="Read this chapter" style={{background:'none',border:`1px solid ${T.bd+'40'}`,borderRadius:5,color:T.dim,padding:'3px 8px',fontSize:U(12),fontFamily:FB}}>▤</button>}
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
              <td style={{padding:'9px 16px',whiteSpace:'nowrap',fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',textTransform:'uppercase',color:st.txt,width:66,verticalAlign:'top',fontWeight:600}}>{v.label}</td>
              <td style={{padding:'9px 4px',fontFamily:FS,fontSize:UL(9),color:T.dim,width:26,verticalAlign:'top',paddingTop:11,fontWeight:500}}>{v.lang}</td>
              <td style={{padding:'9px 16px 9px 6px',fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,lineHeight:readLineHeight,color:st.txt,verticalAlign:'top'}} dangerouslySetInnerHTML={{__html:hl(vd.text,q)}}/>
            </tr>);
          })}
        </tbody>
      </table>
      {!det&&prev&&<div className="text-reveal" style={{fontFamily:fontFamilyMap[readFontFamily],fontStyle:'italic',fontSize:readFontSize,color:T.dim,padding:'8px 18px',borderTop:`1px solid ${T.bd}`}} dangerouslySetInnerHTML={{__html:hl(prev,q)}}/>}
      {hasDet&&(<>
        <div className="s-btn s-ghost" onClick={()=>setDet(!det)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 18px',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',textTransform:'uppercase',color:T.dim,borderTop:`1px solid ${T.bd}`,background:T.bgCH,userSelect:'none',fontWeight:500}}>
          <span style={{display:'inline-block',transition:'transform .2s',transform:det?'rotate(90deg)':'none',fontSize:UL(8)}}>▸</span> Details
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
function Section({sec,entries,versions,q,dark,T,onEditSec,onDelSec,onEdit,onDup,onDel,pulseId,secToggle,idx,isFirst,isLast,onMoveUp,onMoveDown,onRead,readFontSize=19,readLineHeight=1.85,readFontFamily='serif'}){
  const[col,setCol]=useState(true);const[sortBy,setSortBy]=useState('default');
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
        <span style={{color:T.gM,fontSize:UL(9),display:'inline-block',transition:'transform .2s',transform:col?'rotate(-90deg)':'none'}}>▼</span>
        <span style={{fontFamily:FS,fontSize:U(12.5),fontWeight:600,color:T.gT,letterSpacing:'0.04em',flex:1,minWidth:60}}>{sec.title}</span>
        <span style={{fontFamily:FS,fontSize:UL(9.5),color:T.dim,letterSpacing:'0.1em',fontWeight:500}}>{entries.length} {entries.length===1?'entry':'entries'}</span>
        <div style={{display:'flex',gap:5}} onClick={e=>e.stopPropagation()}>
          <select className="s-btn hide-mobile" value={sortBy} onChange={e=>{e.stopPropagation();setSortBy(e.target.value);}} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.06em',padding:'3px 6px',outline:'none',cursor:'pointer'}}>
            <option value="default">Sort: Default</option><option value="bible">Sort: Bible Order</option><option value="issue">Sort: Issue Type</option><option value="status">Sort: Status</option>
          </select>
          <IBtn T={T} ch="↑" onClick={onMoveUp} disabled={isFirst}/>
          <IBtn T={T} ch="↓" onClick={onMoveDown} disabled={isLast}/>
          <IBtn T={T} ch="✎" onClick={()=>onEditSec(sec.id)}/>
          <IBtn T={T} ch="✕" onClick={()=>onDelSec(sec.id)} danger/>
        </div>
      </div>
      {!col&&(<div className="slide-down" style={{border:`1px solid ${T.bdA}`,borderTop:'none',borderRadius:'0 0 10px 10px',background:T.bg,padding:14}}>
        {sec.description&&<div className="text-reveal" style={{fontFamily:fontFamilyMap[readFontFamily],fontStyle:'italic',color:T.mut,fontSize:readFontSize,padding:'8px 14px 14px',borderBottom:`1px solid ${T.bd}`,marginBottom:14,lineHeight:readLineHeight}}>{sec.description}</div>}
        {entries.length===0&&<div style={{textAlign:'center',padding:'28px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15)}}>No entries yet. Add one above.</div>}
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
  const[secId,setSecId]=useState(entry.sectionId||'');
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
          <button className="s-btn" onClick={doFill} disabled={!bkN||!ch||!vs||filling} style={{marginTop:8,background:T.bgSec,border:`1px dashed ${T.gD}`,color:T.gM,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.08em',padding:'6px 13px',borderRadius:5,opacity:(!bkN||!ch||!vs||filling)?.45:1,fontWeight:500}}>{filling?<><Spinner/> Filling…</>:'Auto-fill verse text for all versions'}</button>
        </div>
        <div><Lbl c="Section" T={T} req/><Sel val={secId} set={setSecId} T={T}><option value="" disabled>— Select a section —</option>{sections.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</Sel></div>
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
            <span style={{fontFamily:FS,fontSize:U(10.5),fontWeight:600,color:T.gT,letterSpacing:'0.08em'}}>{v.label}</span>
            <select className="s-btn" value={vSt[v.id]||'faithful'} onChange={e=>setVSt(s=>({...s,[v.id]:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.06em',padding:'4px 8px',outline:'none'}}>
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
  const statusMeta={faithful:{bg:T.green,txt:T.greenTxt},corrupt:{bg:T.red,txt:T.redTxt},diff:{bg:T.dif,txt:T.difTxt},partial:{bg:T.ora,txt:T.oraTxt},missing:{bg:T.pur,txt:T.purTxt}};
  return(
    <div className="no-print" style={{borderTop:`1px solid ${T.bdS}`}}>
      <div style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px 4px 10px'}}>
        <button type="button" onClick={()=>setOpen(!open)}
          style={{display:'flex',alignItems:'center',gap:6,background:'transparent',border:'none',cursor:'pointer',padding:'4px 6px',borderRadius:6,color:active>0?T.gT:T.dim,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',fontWeight:active>0?600:500,flexShrink:0}}>
          <span style={{display:'inline-block',transition:'transform .2s',transform:open?'rotate(90deg)':'none',fontSize:UL(8),lineHeight:1}}>▸</span>
          <span>Filters</span>
          {active>0&&<span style={{background:T.gF,border:`1px solid ${T.gD}`,color:T.gT,fontSize:UL(8),padding:'1px 6px',borderRadius:10,fontWeight:700,letterSpacing:'0.04em'}}>{active}</span>}
        </button>
        {!open&&filters.statuses.length>0&&<div style={{display:'flex',gap:3,overflowX:'auto',scrollbarWidth:'none'}}>
          {filters.statuses.map(s=>{const m=statusMeta[s];return m?(
            <div key={s} style={{display:'inline-flex',alignItems:'center',gap:3,background:m.bg,border:`1px solid ${m.txt}44`,borderRadius:20,padding:'2px 7px',flexShrink:0}}>
              <div style={{width:5,height:5,borderRadius:'50%',background:m.txt}}/>
              <span style={{fontFamily:FS,fontSize:UL(7.5),color:m.txt,fontWeight:600,whiteSpace:'nowrap'}}>{STATUS_LABELS[s]}</span>
            </div>
          ):null;})}
        </div>}
        {hiddenVers!==undefined&&togVer&&(
          <div style={{display:'flex',alignItems:'center',gap:4,marginLeft:'auto',flexShrink:0}}>
            {versions.map(v=>{const hidden=hiddenVers.includes(v.id);return(
              <button key={v.id} type="button" onClick={()=>togVer(v.id)}
                style={{background:hidden?'transparent':T.gF,border:`1px solid ${hidden?T.bd:T.gD}`,borderRadius:6,color:hidden?T.dim:T.gT,fontFamily:FS,fontSize:UL(7),letterSpacing:'0.07em',padding:'3px 7px',fontWeight:hidden?400:600,opacity:hidden?.5:1,cursor:'pointer',transition:'all .15s',textDecoration:hidden?'line-through':'none'}}>
              {v.label}
            </button>);})}
            {(onExpand||onCollapse)&&<>
              <div style={{width:1,height:14,background:T.bd,marginLeft:1}}/>
              <button type="button" title="Expand all" onClick={onExpand} style={{background:'transparent',border:'none',color:T.dim,padding:'4px 5px',cursor:'pointer',lineHeight:1,display:'inline-flex',alignItems:'center'}}><Caret open={false} size={12}/></button>
              <button type="button" title="Collapse all" onClick={onCollapse} style={{background:'transparent',border:'none',color:T.dim,padding:'4px 5px',cursor:'pointer',lineHeight:1,display:'inline-flex',alignItems:'center'}}><Caret open={true} size={12}/></button>
            </>}
          </div>
        )}
      </div>
      {open&&(
        <div className="slide-down" style={{padding:'12px 12px 14px',background:T.bgSec,borderTop:`1px solid ${T.bdS}`,display:'flex',flexDirection:'column',gap:14}}>
          <div>
            <div style={{fontFamily:FS,fontSize:UL(7.5),letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Status</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {['faithful','corrupt','diff','partial','missing'].map(s=>{
                const m=statusMeta[s];const on=filters.statuses.includes(s);
                return m?(
                  <button key={s} type="button" onClick={()=>togS(s)}
                    style={{display:'inline-flex',alignItems:'center',gap:5,background:on?m.bg:'transparent',border:`1px solid ${on?m.txt+'66':T.bd}`,borderRadius:20,padding:'5px 11px 5px 9px',cursor:'pointer',transition:'all .15s'}}>
                    <div style={{width:7,height:7,borderRadius:'50%',background:on?m.txt:T.bd,flexShrink:0,transition:'background .15s'}}/>
                    <span style={{fontFamily:FS,fontSize:UL(9),color:on?m.txt:T.dim,fontWeight:on?600:400,letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{STATUS_LABELS[s]}</span>
                  </button>
                ):null;
              })}
            </div>
          </div>
          <div>
            <div style={{fontFamily:FS,fontSize:UL(7.5),letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Issue Type</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {ISSUE_TYPES.map(t=>{const on=filters.issueTypes.includes(t);return(
                <button key={t} type="button" onClick={()=>togI(t)}
                  style={{background:on?T.gF:'transparent',border:`1px solid ${on?T.gD:T.bd}`,borderRadius:20,padding:'5px 11px',cursor:'pointer',transition:'all .15s'}}>
                  <span style={{fontFamily:FS,fontSize:UL(9),color:on?T.gT:T.dim,fontWeight:on?600:400,letterSpacing:'0.04em'}}>{ISSUE_LABELS[t]||t}</span>
                </button>
              );})}
            </div>
          </div>
          <div>
            <div style={{fontFamily:FS,fontSize:UL(7.5),letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Version Alignment</div>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <select value={filters.vA} onChange={e=>setFilters(f=>({...f,vA:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:U(13),padding:'6px 10px',outline:'none',flex:1,minWidth:80}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
              <span style={{color:T.gM,fontFamily:FS,fontSize:U(13),fontWeight:600}}>≠</span>
              <select value={filters.vB} onChange={e=>setFilters(f=>({...f,vB:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:U(13),padding:'6px 10px',outline:'none',flex:1,minWidth:80}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
            </div>
          </div>
          {active>0&&<button type="button" onClick={()=>setFilters({issueTypes:[],statuses:[],vA:'',vB:''})}
            style={{alignSelf:'flex-start',background:'transparent',border:`1px solid ${T.bd}`,color:T.dim,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'5px 12px',borderRadius:20,cursor:'pointer',fontWeight:500}}>
            ✕ Clear all filters
          </button>}
        </div>
      )}
    </div>
  );
}

function NavBar({data,T,setQ,onScroll,inline}){
  const[bk,setBk]=useState('');const[ch,setCh]=useState('');const[vs,setVs]=useState('');
  function books(){const s=new Set();for(const e of data.entries){const p=parseRef(e.reference);if(p)s.add(p.book);}const order=BIBLE.map(b=>b.name);return[...s].sort((a,b)=>order.indexOf(a)-order.indexOf(b));}
  function chapters(b){const s=new Set();for(const e of data.entries){const p=parseRef(e.reference);if(p&&p.book===b)s.add(p.chapter);}return[...s].sort((a,c)=>parseInt(a)-parseInt(c));}
  function verses(b,c){const o=[];for(const e of data.entries){const p=parseRef(e.reference);if(p&&p.book===b&&p.chapter===c)o.push({label:p.verse,ref:e.reference});}return o;}
  const bks=books();if(!bks.length)return null;const chs=bk?chapters(bk):[];const vss=(bk&&ch)?verses(bk,ch):[];
  const dd=(a)=>({background:T.bgIn,border:`1px solid ${T.bd}`,color:a?T.mut:T.dim,fontFamily:FB,fontSize:U(13),padding:'4px 7px',borderRadius:5,opacity:a?1:.4,outline:'none'});
  const inner=(<>
    <span style={{fontFamily:FS,fontSize:UL(8.5),color:T.gM,letterSpacing:'0.1em',textTransform:'uppercase',flexShrink:0,fontWeight:600}}>Go to</span>
    <select className="s-btn" value={bk} onChange={e=>{setBk(e.target.value);setCh('');setVs('');setQ(e.target.value||'');}} style={dd(true)}><option value="">— Book —</option>{bks.map(b=><option key={b} value={b}>{b}</option>)}</select>
    <select className="s-btn" value={ch} disabled={!bk} onChange={e=>{setCh(e.target.value);setVs('');setQ(bk+' '+e.target.value);}} style={dd(!!bk)}><option value="">— Ch —</option>{chs.map(c=><option key={c} value={c}>{c}</option>)}</select>
    <select className="s-btn" value={vs} disabled={!ch} onChange={e=>{const r=e.target.value;setVs(r);if(r){setQ('');onScroll(r);}}} style={dd(!!ch)}><option value="">— Vs —</option>{vss.map(v=><option key={v.ref} value={v.ref}>{v.label}</option>)}</select>
    {bk&&<button type="button" className="s-btn s-ghost" onClick={()=>{setBk('');setCh('');setVs('');setQ('');}} style={{background:'none',border:'none',color:T.dim,fontFamily:FS,fontSize:UL(10)}}>✕</button>}
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
  const tc={padding:'7px 12px',fontFamily:FB,fontSize:U(14),borderBottom:`1px solid ${T.bd}`,color:T.body,textAlign:'center'};
  const th={...tc,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',textTransform:'uppercase',color:T.gM,fontWeight:600,borderBottom:`2px solid ${T.bdA}`};
  return(
    <Modal title="Statistics" onClose={onClose} wide T={T} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      <div style={{fontFamily:FB,fontSize:U(15),color:T.mut,marginBottom:14,lineHeight:1.7}}>{total} passage{total!==1?'s':''} across {data.sections.length} section{data.sections.length!==1?'s':''}, comparing {data.versions.length} version{data.versions.length!==1?'s':''}.</div>
      <OrnRule T={T}/>
      <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:10,marginTop:12,fontWeight:600}}>Version Agreement with {refLabel}</div>
      <div style={{overflowX:'auto',marginBottom:16}}>
        <table style={{width:'100%',borderCollapse:'collapse',minWidth:500}}>
          <thead><tr>{['Version','Passages','Faithful','Corrupt','Differs','Partial','Absent','Agreement'].map(h=><th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>{vStats.map(({v,t,faithful,corrupt,differs,partial,absent,pct})=>(<tr key={v.id}><td style={{...tc,textAlign:'left',fontWeight:600,color:T.gT}}>{v.label}{v.isRef?' (Ref)':''}</td><td style={tc}>{t}</td><td style={{...tc,color:T.greenTxt}}>{faithful}</td><td style={{...tc,color:T.redTxt}}>{corrupt}</td><td style={{...tc,color:T.difTxt}}>{differs}</td><td style={{...tc,color:T.oraTxt}}>{partial}</td><td style={{...tc,color:T.purTxt}}>{absent}</td><td style={{...tc,fontWeight:600,color:pct>80?T.greenTxt:pct>50?T.ambTxt:T.redTxt}}>{pct}%</td></tr>))}</tbody>
        </table>
      </div>
      {Object.keys(iC).length>0&&(<>
        <OrnRule T={T}/>
        <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:10,marginTop:12,fontWeight:600}}>Issues by Type</div>
        {Object.entries(iC).sort(([,a],[,b])=>b-a).map(([t,n])=>{const mx=Math.max(1,...Object.values(iC));return(
          <div key={t} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
            <span style={{fontFamily:FS,fontSize:UL(10),color:T.dim,width:90,flexShrink:0,fontWeight:500}}>{ISSUE_LABELS[t]||t}</span>
            <div style={{flex:1,height:6,background:T.bgSec,borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.round((n/mx)*100)}%`,background:iCol[t]||'#786248',borderRadius:3}}/></div>
            <span style={{fontFamily:FB,fontSize:U(14),color:T.body,minWidth:24,textAlign:'right'}}>{n}</span>
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
      <span style={{fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.14em',textTransform:'uppercase',color:T.g,flexShrink:0,fontWeight:600}}>Deleted</span>
      <span style={{fontFamily:FB,fontSize:U(15),color:T.mut,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ud.label}</span>
      <button className="s-btn" onClick={onUndo} style={{background:T.g,border:'none',color:'#0e0d0b',fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.08em',padding:'5px 13px',borderRadius:4,fontWeight:600,flexShrink:0}}>↺ Undo</button>
      <button className="s-btn s-ghost" onClick={onDismiss} style={{background:'none',border:'none',color:T.dim,fontSize:U(14),padding:'2px 6px',flexShrink:0}}>✕</button>
    </div>
    <div style={{height:3,background:T.bd}}><div style={{height:'100%',width:`${ud.pct}%`,background:T.g,transition:'width 0.1s linear'}}/></div>
  </div>);
}


// ══════════════════════════════════════════════════════════
//  MOBILE BOTTOM SHEET
// ══════════════════════════════════════════════════════════
function MobileSheet({onClose,children,T,title,onScroll,fromTop,fullScreen,sheetHeight,maxSheetHeight,isClosing,topOffset=0,noScroll=false,topPad,fade,fadeKey}){
  const[internalClosing,setInternalClosing]=React.useState(false);
  const closing=isClosing||internalClosing;
  const overlayRef=React.useRef(null);

  // Prevent background scroll-through on iOS WKWebView.
  // Only allow scroll gestures on elements that are truly scrollable AND
  // actually have overflowing content — everything else does nothing.
  React.useEffect(()=>{
    const el=overlayRef.current;
    if(!el)return;
    const prevent=(e)=>{
      let node=e.target;
      while(node&&node!==el){
        const oy=window.getComputedStyle(node).overflowY;
        // Require >60px of real scrollable content so padding-only overflow
        // (the 32px bottom pad on the sheet container) doesn't count as scrollable.
        if((oy==='auto'||oy==='scroll')&&node.scrollHeight-node.clientHeight>60)return;
        node=node.parentNode;
      }
      e.preventDefault();
    };
    el.addEventListener('touchmove',prevent,{passive:false});
    return()=>el.removeEventListener('touchmove',prevent);
  },[]);

  function dismiss(){setInternalClosing(true);onClose();}
  const edge=useEdgeFade(fade&&!noScroll,T,fadeKey);
  const{ref:panelRef,handlers:dragHandlers}=useSheetDrag(fromTop?-1:1,dismiss);


  return(
    <div ref={overlayRef} onClick={e=>{if(e.target===e.currentTarget)dismiss();}}
      style={{position:'fixed',inset:0,zIndex:180,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(3px)',
        opacity:closing?0:1,transition:closing?'opacity .25s ease-in':'none'}}>
      <div className={closing?(fromTop?'slide-down-sheet-out':'slide-up-sheet-out'):(fromTop?'slide-down-sheet':'slide-up-sheet')} onClick={e=>e.stopPropagation()}
        style={{position:'absolute',...(fromTop?{top:topOffset}:{bottom:0}),left:0,right:0,background:T.bgCard,
          borderRadius:fromTop?'0 0 18px 18px':'18px 18px 0 0',
          ...(fromTop?{borderBottom:`2px solid ${T.bdA}`}:{borderTop:`2px solid ${T.bdA}`}),
          maxHeight:sheetHeight||maxSheetHeight||(fullScreen?'100vh':fromTop?`calc(100vh - ${topOffset}px - 50px)`:'82vh'),height:sheetHeight||(fullScreen?'100vh':undefined),display:'flex',flexDirection:'column',overflow:'hidden',
          boxShadow:fromTop?'0 20px 60px rgba(0,0,0,0.5)':'0 -20px 60px rgba(0,0,0,0.5)',
          transition:closing?'none':'max-height .12s cubic-bezier(0.4,0,0.2,1), height .12s cubic-bezier(0.4,0,0.2,1)'}} ref={panelRef}>

        {!fromTop&&<div style={{height:3,background:T.accentLine}}/>}
        {!fromTop&&<div {...dragHandlers}
          style={{position:'relative',display:'flex',flexDirection:'column',alignItems:'center',padding:'10px 0 2px',flexShrink:0,touchAction:'none',cursor:'grab'}}>
          <GripReach/>
          <div style={{width:36,height:4,background:T.bdA,borderRadius:2,marginBottom:6}}/>
          {title&&<div style={{fontFamily:FS,fontSize:U(11),fontWeight:600,color:T.gT,letterSpacing:'0.1em',marginBottom:2}}>{title}</div>}
        </div>}
        <div style={{position:'relative',flex:1,minHeight:0,display:'flex',flexDirection:'column'}}>
          <div ref={edge.ref} className="sheet-scroll" style={{overflowY:noScroll?'hidden':'auto',overscrollBehavior:'none',flex:1,padding:fromTop?`${topPad??20}px 18px 32px`:'6px 18px 32px'}} onScroll={onScroll}>
            {children}
          </div>
          {fade&&!noScroll&&<EdgeFades fade={edge} height={48} top={fade!=='bottom'}/>}
        </div>
        {fromTop&&<div {...dragHandlers}
          style={{position:'relative',display:'flex',flexDirection:'column',alignItems:'center',padding:'2px 0 10px',flexShrink:0,touchAction:'none',cursor:'grab'}}>
          <GripReach up/>
          {title&&<div style={{fontFamily:FS,fontSize:U(11),fontWeight:600,color:T.gT,letterSpacing:'0.1em',marginBottom:6}}>{title}</div>}
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
              <div style={{fontFamily:FS,fontSize:U(15),fontWeight:700,letterSpacing:'0.06em',color:'#f08080',marginBottom:3}}>Reset to Defaults</div>
              <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',color:'#8a3030',fontWeight:500}}>This action cannot be undone</div>
            </div>
          </div>
          <div style={{background:'#200808',border:'1px solid #6a1818',borderRadius:8,padding:'16px 18px',marginBottom:18}}>
            <div style={{fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.12em',textTransform:'uppercase',color:'#d46868',marginBottom:10,fontWeight:600}}>The following will be permanently deleted:</div>
            <div style={{fontFamily:FB,fontSize:U(15),color:'#c09090',lineHeight:2}}>
              &#x2022; All <strong style={{color:'#f08080'}}>{entryCount} comparison {entryCount===1?'entry':'entries'}</strong> and their verse texts<br/>
              &#x2022; All <strong style={{color:'#f08080'}}>{sectionCount} {sectionCount===1?'section':'sections'}</strong><br/>
              &#x2022; All <strong style={{color:'#f08080'}}>bookmarks</strong> and <strong style={{color:'#f08080'}}>reading history</strong><br/>
              &#x2022; All <strong style={{color:'#f08080'}}>version settings</strong> (uploaded CSVs remain in your account)<br/>
              &#x2022; All <strong style={{color:'#f08080'}}>display preferences</strong> (theme, hidden versions, filters)
            </div>
          </div>
          <div style={{background:'#0a1a0a',border:'1px solid #2a4a2a',borderRadius:8,padding:'14px 18px',marginBottom:22}}>
            <div style={{fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.12em',textTransform:'uppercase',color:'#62c484',marginBottom:8,fontWeight:600}}>The app will be restored to:</div>
            <div style={{fontFamily:FB,fontSize:U(14),color:'#7ab890',lineHeight:1.9}}>
              KJV + RVG versions &nbsp;&#xB7;&nbsp; 2 default sections &nbsp;&#xB7;&nbsp; Genesis 1:1 and John 3:16 sample entries &nbsp;&#xB7;&nbsp; Dark mode
            </div>
          </div>
          <div style={{marginBottom:6}}>
            <div style={{fontFamily:FS,fontSize:UL(9.5),color:'#c09090',letterSpacing:'0.1em',marginBottom:8,fontWeight:500}}>
              Type <strong style={{color:'#f08080',letterSpacing:'0.16em'}}>RESET</strong> to confirm:
            </div>
            <input
              value={typed}
              onChange={e=>setTyped(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter'&&ready)onConfirm();}}
              placeholder="Type RESET here..."
              autoFocus
              style={{width:'100%',background:'#0e0505',border:`2px solid ${ready?'#c83030':'#4a1a1a'}`,borderRadius:6,color:'#f08080',fontFamily:FS,fontSize:U(14),letterSpacing:'0.12em',padding:'10px 14px',outline:'none',transition:'border-color .2s',boxSizing:'border-box'}}
            />
          </div>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,padding:'18px 30px 24px',background:'rgba(0,0,0,0.25)',borderTop:'1px solid #3a1010'}}>
          <SBtn ch="Cancel — Keep My Data" onClick={onCancel} T={T}/>
          <button
            onClick={()=>{if(ready)onConfirm();}}
            disabled={!ready}
            style={{background:ready?'#8a1010':'#2a0808',border:`1px solid ${ready?'#c83030':'#4a1414'}`,borderRadius:6,color:ready?'#f08080':'#5a2020',fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.12em',textTransform:'uppercase',padding:'9px 20px',fontWeight:700,cursor:ready?'pointer':'default',opacity:ready?1:.5,transition:'all .2s'}}>
            &#9888; Reset Everything
          </button>
        </div>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════════
//  SCRIPTURE ATLAS MAPS
// ══════════════════════════════════════════════════════════
// Pinch to zoom, drag to pan, double-tap to toggle. The viewport is locked to
// user-scalable=no so the browser never zooms on its own, which is right for the
// reader but left maps with no way in at all and charts with a single fixed step.
// Listeners are attached by hand because React registers touchmove as passive, so
// preventDefault from a synthetic handler is ignored and the page scrolls instead.
function PinchZoom({src,alt,onZoomChange,maxScale}){
  const wrapRef=React.useRef(null);
  const imgRef=React.useRef(null);
  const st=React.useRef({scale:1,tx:0,ty:0});
  const gest=React.useRef(null);
  const lastTap=React.useRef(0);
  // Maps carry far more detail than the charts do, so they are allowed to go deeper.
  const MAX_SCALE=maxScale||6;
  React.useEffect(()=>{
    const wrap=wrapRef.current;
    if(!wrap)return;
    const apply=()=>{
      const el=imgRef.current;
      if(el)el.style.transform=`translate(${st.current.tx}px,${st.current.ty}px) scale(${st.current.scale})`;
    };
    // Never let the image be dragged off its own frame, and pin it dead centre at 1x.
    const clamp=()=>{
      const el=imgRef.current;
      if(!el)return;
      const r=wrap.getBoundingClientRect();
      const mx=Math.max(0,(el.offsetWidth*st.current.scale-r.width)/2);
      const my=Math.max(0,(el.offsetHeight*st.current.scale-r.height)/2);
      st.current.tx=Math.max(-mx,Math.min(mx,st.current.tx));
      st.current.ty=Math.max(-my,Math.min(my,st.current.ty));
    };
    const commit=was=>{
      clamp();apply();
      if((was>1)!==(st.current.scale>1)&&onZoomChange)onZoomChange(st.current.scale>1);
    };
    const gap=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    const mid=t=>({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});
    const onStart=e=>{
      // Promoted only while the fingers are down. Left on permanently, the image
      // sits on a compositor layer rasterised at the size it had when the layer
      // was made, and pinching stretches that bitmap instead of redrawing at the
      // new scale — so zooming in got softer than the file warrants. Dropping it
      // on release lets Safari rasterise again at the scale you settled on.
      if(imgRef.current)imgRef.current.style.willChange='transform';
      const t=e.touches;
      if(t.length===2){
        e.preventDefault();
        gest.current={mode:'pinch',d0:gap(t),s0:st.current.scale,m0:mid(t),tx0:st.current.tx,ty0:st.current.ty};
      }else if(t.length===1&&st.current.scale>1){
        gest.current={mode:'pan',x0:t[0].clientX,y0:t[0].clientY,tx0:st.current.tx,ty0:st.current.ty};
      }else gest.current=null;
    };
    const onMove=e=>{
      const g=gest.current,t=e.touches;
      if(!g)return;
      if(g.mode==='pinch'&&t.length===2){
        e.preventDefault();
        const was=st.current.scale,m=mid(t);
        st.current.scale=Math.max(1,Math.min(MAX_SCALE,g.s0*(gap(t)/g.d0)));
        st.current.tx=g.tx0+(m.x-g.m0.x);
        st.current.ty=g.ty0+(m.y-g.m0.y);
        commit(was);
      }else if(g.mode==='pan'&&t.length===1){
        e.preventDefault();   // otherwise the swipe-to-next-image gesture steals it
        st.current.tx=g.tx0+(t[0].clientX-g.x0);
        st.current.ty=g.ty0+(t[0].clientY-g.y0);
        clamp();apply();
      }
    };
    const onEnd=e=>{
      if(e.touches.length)return;
      if(imgRef.current)imgRef.current.style.willChange='';
      const wasPinch=gest.current&&gest.current.mode==='pinch';
      gest.current=null;
      // A pinch that ends near 1x should settle exactly there, not at 1.01.
      if(st.current.scale<=1.02){const was=st.current.scale;st.current={scale:1,tx:0,ty:0};commit(was);}
      if(wasPinch)return;
      const now=Date.now();
      if(now-lastTap.current<300){
        const was=st.current.scale;
        st.current=was>1?{scale:1,tx:0,ty:0}:{scale:2.5,tx:0,ty:0};
        commit(was);
        lastTap.current=0;
      }else lastTap.current=now;
    };
    wrap.addEventListener('touchstart',onStart,{passive:false});
    wrap.addEventListener('touchmove',onMove,{passive:false});
    wrap.addEventListener('touchend',onEnd);
    return()=>{
      wrap.removeEventListener('touchstart',onStart);
      wrap.removeEventListener('touchmove',onMove);
      wrap.removeEventListener('touchend',onEnd);
    };
  },[onZoomChange,maxScale]);
  // A new image starts unzoomed.
  React.useEffect(()=>{
    st.current={scale:1,tx:0,ty:0};
    if(imgRef.current)imgRef.current.style.transform='';
    if(onZoomChange)onZoomChange(false);
  },[src]);
  return(
    <div ref={wrapRef} style={{flex:1,minHeight:0,width:'100%',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',touchAction:'none'}}>
      <img ref={imgRef} src={src} alt={alt} draggable={false}
        style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain',display:'block',transformOrigin:'center center',userSelect:'none',WebkitUserSelect:'none'}}/>
    </div>
  );
}
function MapLightboxGrid({maps,BASE,T}){
  const[lightbox,setLightbox]=useState(null);
  const mapTouchX=useRef(null);
  const mapSwiped=useRef(false);
  const[mapZoomed,setMapZoomed]=useState(false);
  useEffect(()=>{
    if(lightbox===null)return;
    const fn=e=>{if(e.key==='ArrowRight')setLightbox(i=>Math.min(i+1,maps.length-1));else if(e.key==='ArrowLeft')setLightbox(i=>Math.max(i-1,0));else if(e.key==='Escape')setLightbox(null);};
    window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn);
  },[lightbox,maps.length]);
  const mapOnTouchStart=e=>{mapTouchX.current=e.touches[0].clientX;mapSwiped.current=false;};
  const mapOnTouchEnd=e=>{
    if(mapTouchX.current===null)return;
    const dx=e.changedTouches[0].clientX-mapTouchX.current;
    mapTouchX.current=null;
    if(mapZoomed)return;   // a drag across a zoomed map is a pan, not a page turn
    if(Math.abs(dx)>40){mapSwiped.current=true;if(dx<0)setLightbox(i=>Math.min(i+1,maps.length-1));else setLightbox(i=>Math.max(i-1,0));}
  };
  return(
    <>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:8}}>
        {maps.map((m,i)=>(
          <div key={m.file} onClick={()=>setLightbox(i)} style={{display:'flex',flexDirection:'column',gap:5,cursor:'pointer'}}>
            <div style={{aspectRatio:'4/3',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:7,overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <img src={`${BASE}maps/thumb/${m.file}`} alt={m.title} style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}} loading="lazy"/>
            </div>
            <div style={{fontFamily:'Georgia,serif',fontSize:UL(10),color:T.dim,textAlign:'center',lineHeight:1.3,paddingBottom:2}}>{m.title}</div>
          </div>
        ))}
      </div>
      {lightbox!==null&&(
        <div style={{position:'fixed',inset:0,zIndex:400,background:'rgba(0,0,0,0.96)',display:'flex',flexDirection:'column'}} onTouchStart={mapOnTouchStart} onTouchEnd={mapOnTouchEnd} onClick={()=>{if(mapSwiped.current){mapSwiped.current=false;return;}setLightbox(null);}}>
          <div style={{flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'calc(env(safe-area-inset-top,0px) + 10px) 16px 10px',background:'rgba(0,0,0,0.6)'}} onClick={e=>e.stopPropagation()}>
            <div style={{fontFamily:'Georgia,serif',fontSize:U(12),color:'rgba(200,168,78,0.85)',letterSpacing:'0.06em',flex:1}}>{maps[lightbox].title}</div>
            <div style={{fontFamily:'Georgia,serif',fontSize:UL(10),color:'rgba(255,255,255,0.35)',marginRight:12}}>{lightbox+1} / {maps.length}</div>
            <button type="button" onClick={()=>setLightbox(null)} title="Close" aria-label="Close" style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.25)',borderRadius:9,color:'rgba(255,255,255,0.85)',fontSize:UH(17),cursor:'pointer',width:40,height:40,minWidth:40,padding:0,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1,flexShrink:0,boxSizing:'border-box'}}>✕</button>
          </div>
          <PinchZoom src={`${BASE}maps/${maps[lightbox].file}`} alt={maps[lightbox].title} onZoomChange={setMapZoomed} maxScale={12}/>
          <div style={{flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:`10px 16px calc(env(safe-area-inset-bottom,0px) + 10px)`,background:'rgba(0,0,0,0.6)'}} onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setLightbox(i=>Math.max(i-1,0))} disabled={lightbox===0}
              style={{background:'none',border:`1px solid ${lightbox===0?'rgba(255,255,255,0.1)':'rgba(200,168,78,0.4)'}`,borderRadius:6,color:lightbox===0?'rgba(255,255,255,0.2)':'rgba(200,168,78,0.8)',fontFamily:'Georgia,serif',fontSize:U(11),letterSpacing:'0.08em',padding:'7px 18px',cursor:lightbox===0?'default':'pointer'}}>‹ Prev</button>
            <div style={{fontFamily:'Georgia,serif',fontSize:UL(11),color:'rgba(200,168,78,0.75)',letterSpacing:'0.1em',textTransform:'uppercase'}}>Pinch to zoom</div>
            <button onClick={()=>setLightbox(i=>Math.min(i+1,maps.length-1))} disabled={lightbox===maps.length-1}
              style={{background:'none',border:`1px solid ${lightbox===maps.length-1?'rgba(255,255,255,0.1)':'rgba(200,168,78,0.4)'}`,borderRadius:6,color:lightbox===maps.length-1?'rgba(255,255,255,0.2)':'rgba(200,168,78,0.8)',fontFamily:'Georgia,serif',fontSize:U(11),letterSpacing:'0.08em',padding:'7px 18px',cursor:lightbox===maps.length-1?'default':'pointer'}}>Next ›</button>
          </div>
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════
//  LARKIN CHARTS
// ══════════════════════════════════════════════════════════
function LarkinLightbox({imgs,startIdx,BASE,T,onClose}){
  const[idx,setIdx]=useState(startIdx);
  const[zoomed,setZoomed]=useState(false);
  const lkTouchX=useRef(null);
  const lkSwiped=useRef(false);
  const cur=imgs[idx];
  useEffect(()=>{
    const fn=e=>{if(e.key==='ArrowRight')setIdx(i=>Math.min(i+1,imgs.length-1));else if(e.key==='ArrowLeft')setIdx(i=>Math.max(i-1,0));else if(e.key==='Escape')onClose();};
    window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn);
  },[imgs.length,onClose]);
  const lkOnTouchStart=e=>{lkTouchX.current=e.touches[0].clientX;lkSwiped.current=false;};
  const lkOnTouchEnd=e=>{
    if(lkTouchX.current===null)return;
    const dx=e.changedTouches[0].clientX-lkTouchX.current;
    lkTouchX.current=null;
    if(zoomed)return;
    if(Math.abs(dx)>40){lkSwiped.current=true;if(dx<0)setIdx(i=>Math.min(i+1,imgs.length-1));else setIdx(i=>Math.max(i-1,0));}
  };
  return(
    <div style={{position:'fixed',inset:0,zIndex:400,background:'rgba(0,0,0,0.96)',display:'flex',flexDirection:'column'}} onTouchStart={lkOnTouchStart} onTouchEnd={lkOnTouchEnd} onClick={()=>{if(lkSwiped.current){lkSwiped.current=false;return;}zoomed?setZoomed(false):onClose();}}>
      {/* Top bar */}
      <div style={{flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'calc(env(safe-area-inset-top,0px) + 10px) 16px 10px',background:'rgba(0,0,0,0.6)'}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:'Georgia,serif',fontSize:U(11),color:'rgba(200,168,78,0.8)',letterSpacing:'0.06em',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:12}}>{cur.section} {imgs.filter(x=>x.section===cur.section).length>1?`· Chart ${imgs.slice(0,idx+1).filter(x=>x.section===cur.section).length}`:''}</div>
        <div style={{fontFamily:'Georgia,serif',fontSize:UL(10),color:'rgba(255,255,255,0.35)',marginRight:12}}>{idx+1} / {imgs.length}</div>
        <button type="button" onClick={onClose} title="Close" aria-label="Close" style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.25)',borderRadius:9,color:'rgba(255,255,255,0.85)',fontSize:UH(17),cursor:'pointer',width:40,height:40,minWidth:40,padding:0,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1,flexShrink:0,boxSizing:'border-box'}}>✕</button>
      </div>
      {/* Image */}
        <PinchZoom src={`${BASE}charts/larkin/${cur.img}`} alt={cur.section} onZoomChange={setZoomed} maxScale={10}/>
      {/* Prev / Next */}
      <div style={{flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:`10px 16px calc(env(safe-area-inset-bottom,0px) + 10px)`,background:'rgba(0,0,0,0.6)'}} onClick={e=>e.stopPropagation()}>
        <button onClick={()=>setIdx(i=>Math.max(i-1,0))} disabled={idx===0}
          style={{background:'none',border:`1px solid ${idx===0?'rgba(255,255,255,0.1)':'rgba(200,168,78,0.4)'}`,borderRadius:6,color:idx===0?'rgba(255,255,255,0.2)':'rgba(200,168,78,0.8)',fontFamily:'Georgia,serif',fontSize:U(11),letterSpacing:'0.08em',padding:'7px 18px',cursor:idx===0?'default':'pointer'}}>‹ Prev</button>
        <div style={{fontFamily:'Georgia,serif',fontSize:UL(11),color:'rgba(200,168,78,0.75)',letterSpacing:'0.1em',textTransform:'uppercase'}}>Pinch to zoom</div>
        <button onClick={()=>setIdx(i=>Math.min(i+1,imgs.length-1))} disabled={idx===imgs.length-1}
          style={{background:'none',border:`1px solid ${idx===imgs.length-1?'rgba(255,255,255,0.1)':'rgba(200,168,78,0.4)'}`,borderRadius:6,color:idx===imgs.length-1?'rgba(255,255,255,0.2)':'rgba(200,168,78,0.8)',fontFamily:'Georgia,serif',fontSize:U(11),letterSpacing:'0.08em',padding:'7px 18px',cursor:idx===imgs.length-1?'default':'pointer'}}>Next ›</button>
      </div>
    </div>
  );
}
function LarkinSection({title,imgs,BASE,T,allImgs}){
  const[open,setOpen]=useState(false);
  const[lightbox,setLightbox]=useState(null);
  const startIdx=allImgs.findIndex(x=>x.img===imgs[0]);
  return(
    <div style={{marginBottom:4}}>
      <div onClick={()=>setOpen(v=>!v)} style={{display:'flex',alignItems:'center',gap:8,padding:'9px 4px',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',borderBottom:`1px solid ${T.bdS}`}}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke={T.dim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,transition:'transform .15s',transform:open?'rotate(90deg)':'rotate(0deg)'}}><path d="M2 1L6 4L2 7"/></svg>
        <span style={{fontFamily:'Georgia,serif',fontSize:U(12),fontWeight:600,color:T.gT,letterSpacing:'0.04em',flex:1}}>{title}</span>
        <span style={{fontFamily:'Georgia,serif',fontSize:UL(10),color:T.dim,flexShrink:0}}>{imgs.length}</span>
      </div>
      {open&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(110px,1fr))',gap:6,padding:'8px 0 10px'}}>
          {imgs.map((img,i)=>(
            <div key={img} onClick={()=>setLightbox(startIdx+i)}
              style={{aspectRatio:'4/3',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,overflow:'hidden',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <img src={`${BASE}charts/larkin/${img}`} alt={`${title} ${i+1}`}
                style={{width:'100%',height:'100%',objectFit:'contain',display:'block'}} loading="lazy"/>
            </div>
          ))}
        </div>
      )}
      {lightbox!==null&&<LarkinLightbox imgs={allImgs} startIdx={lightbox} BASE={BASE} T={T} onClose={()=>setLightbox(null)}/>}
    </div>
  );
}

// ── UserBlobThumb: loads an image blob from IDB and renders as a thumbnail ──
function UserBlobThumb({id,mime,title,T}){
  const[src,setSrc]=useState(null);
  useEffect(()=>{
    let url=null;
    idbGetResourceBlob(id).then(blob=>{
      if(blob?.data){url=URL.createObjectURL(new Blob([blob.data],{type:mime}));setSrc(url);}
    }).catch(()=>{});
    return()=>{if(url)URL.revokeObjectURL(url);};
  },[id,mime]);
  if(!src)return <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:12,width:'100%',height:'100%'}}><div style={{fontSize:UH(28),marginBottom:6}}>▣</div><div style={{fontFamily:'system-ui',fontSize:U(11),color:T.body,lineHeight:1.3,textAlign:'center',overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',maxWidth:'100%'}}>{title}</div></div>;
  return <img src={src} alt={title} style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>;
}

// ══════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════
function App(){
  // ── Auth ──
  const[user,setUser]=useState(null);
  const[authChecked,setAuthChecked]=useState(false);
  const bootChapter=useRef(false);
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
  const[accent,setAccent]=useState(()=>{try{return localStorage.getItem('scrip:accent')||AD.accent;}catch{return AD.accent;}});
  const[customAccentHex,setCustomAccentHex]=useState(()=>{try{return localStorage.getItem('scrip:accentCustom')||AD.accentCustom;}catch{return AD.accentCustom;}});
  const[customPickerOpen,setCustomPickerOpen]=useState(false);
  const[pickerH,setPickerH]=useState(43);
  const[pickerS,setPickerS]=useState(53);
  const[pickerL,setPickerL]=useState(55);
  const pickerOrigRef=useRef({accent:'gold',hex:'#c8a84e'});
  const[tab,setTab]=useState('read'); // 'read'|'study'|'parallel'|'compare'|'strongs'|'dictionary'
  const[q,setQ]=useState('');
  const[filters,setFilters]=useState({issueTypes:[],statuses:[],vA:'',vB:''});
  const[hiddenVers,setHiddenVers]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:hidden')||'[]');}catch{return[];}});
  const[modal,setModal]=useState(null);
  const[modalClosing,setModalClosing]=useState(false);
  const _topSheetTypes=['versions','bookmarks','highlights','recents','help'];
  const studyBack=modal?.from==='study'?()=>closeModal(()=>setReadMobileSheet('studyTools')):undefined;
  function closeModal(then){
    if(_topSheetTypes.includes(modal?.type)){
      setModalClosing(true);
      setTimeout(()=>{setModal(null);setModalClosing(false);if(typeof then==='function')then();},260);
    }else{setModal(null);if(typeof then==='function')then();}
  }
  const[undo,setUndo]=useState(null);
  const[pulseId,setPulseId]=useState(null);
  const[secToggle,setSecToggle]=useState(null);
  const[mobileSheet,setMobileSheet]=useState(null);
  const[mobileSheetClosing,setMobileSheetClosing]=useState(false);
  function closeMobileSheet(){setMobileSheetClosing(true);setTimeout(()=>{setMobileSheet(null);setMobileSheetClosing(false);},260);}
  const[readSheetClosing,setReadSheetClosing]=useState(false);
  const[versionSheetView,setVersionSheetView]=useState('list');
  const[manageVers,setManageVers]=useState([]);
  const[mngLocalAvail,setMngLocalAvail]=useState({});
  const[mngImportLabel,setMngImportLabel]=useState('');
  const[mngImportLang,setMngImportLang]=useState('ES');
  const[mngImportFile,setMngImportFile]=useState(null);
  const[mngImporting,setMngImporting]=useState(null);
  const[mngImportProg,setMngImportProg]=useState([0,0]);
  const[mngImportErr,setMngImportErr]=useState('');
  const[mngImportNote,setMngImportNote]=useState('');
  const mngImportedHere=useRef(new Map()); // id -> label, imported since the view opened
  // The close animation runs 260ms before the sheet unmounts, and that timer
  // used to belong to nobody: open another sheet inside the window and it
  // landed on the new one, unmounting the menu just opened — which had been
  // rendering the old one's closing animation from its first frame, since
  // readSheetClosing was still set. It reads as the button you pressed closing
  // the menu you were already in.
  const readSheetTimer=useRef(null);
  function closeReadSheet(){
    if(readSheetTimer.current)clearTimeout(readSheetTimer.current);
    setReadSheetClosing(true);
    readSheetTimer.current=setTimeout(()=>{readSheetTimer.current=null;setReadMobileSheet(null);setReadSheetClosing(false);setVersionSheetView('list');},260);
  }
  // Opening anything retires a close still in flight, so it cannot take the
  // new sheet down with the old one.
  function cancelSheetClose(){if(readSheetTimer.current){clearTimeout(readSheetTimer.current);readSheetTimer.current=null;}setReadSheetClosing(false);}
  // iOS only synthesizes the click once the finger lifts. A sheet animating
  // under that finger can move or replace what it was on, and the click then
  // lands somewhere else or nowhere — a few pixels of slide does the same. So
  // the nav's own buttons act at finger-down, where the target is still what
  // was aimed at, and swallow the click that follows. Keyboard and mouse-only
  // paths still arrive as a click and run normally.
  const navTapAt=useRef(0);
  function navTap(fn){
    if(!fn)return{};
    return{
      onPointerDown:e=>{if(e.button)return;navTapAt.current=Date.now();fn();},
      onClick:()=>{if(Date.now()-navTapAt.current<700)return;fn();},
    };
  }
  // Moving straight from one sheet to another never goes through closeReadSheet,
  // so it would skip the reset that puts the version sheet back on its list and
  // the sheet would reopen wherever it was last left.
  function openReadSheet(name){
    // A sheet is somewhere else, so search closes with it — results included.
    // The book picker used to take only the field: choosing a chapter from it
    // dropped the reader back onto the last search results with no field left
    // to close them, a bar naming one book over verses from another.
    cancelSheetClose();
    setSearchFieldOpen(false);
    setReadSearchResultsOpen(false);
    abandonSearch();
    if(readMobileSheet&&readMobileSheet!==name)setVersionSheetView('list');
    setReadMobileSheet(name);
  }
  function openManageView(){
    setManageVers(clone(data.versions));
    setVersionSheetView('manage');
    setMngImportErr('');setMngImportNote('');setMngImportFile(null);setMngImportLabel('');
    mngImportedHere.current=new Map();
    // Check local availability for user-imported versions
    const uv=data.versions.filter(v=>!PUBLIC_VERSIONS.some(pv=>pv.id===v.id));
    uv.forEach(v=>{idbIsDownloaded(v.id).then(ok=>setMngLocalAvail(a=>({...a,[v.id]:ok})));});
  }
  function manageRemove(id){setManageVers(v=>v.filter(x=>x.id!==id));}
  function manageAddBuiltin(pv){setManageVers(v=>[...v,{id:pv.id,label:pv.label,lang:pv.lang,isRef:false}]);}
  async function manageDoSave(){let v=[...manageVers];if(!v.some(x=>x.isRef)&&v.length)v[0]={...v[0],isRef:true};if(await saveVersions(v,[...mngImportedHere.current].map(([id,label])=>({id,label}))))setVersionSheetView('list');}
  async function mngDoImport(){
    if(!mngImportFile||!mngImportLabel.trim())return;
    // Same name and language as one already imported: replace it, don't add a twin.
    const match=findOwnImport(manageVers,mngImportLabel,mngImportLang,user?.id);
    setMngImportErr('');setMngImportNote('');setMngImporting(match?match.id:'new');setMngImportProg([0,0]);
    try{
      const v=await importBblxFile({file:mngImportFile,label:match?match.label:mngImportLabel.trim(),lang:match?match.lang:mngImportLang,userId:user?.id,existingVersionId:match?.id,onProgress:(d,t)=>setMngImportProg([d,t])});
      if(!match){setManageVers(vs=>[...vs,v]);mngImportedHere.current.set(v.id,v.label);}
      setMngLocalAvail(a=>({...a,[v.id]:true}));
      if(match)setMngImportNote(`Replaced your existing ${match.label}.`);
      setMngImportLabel('');setMngImportFile(null);
    }catch(e){setMngImportErr(e.message);}
    finally{setMngImporting(null);}
  }
  async function mngDoReImport(vId,file){
    const v=manageVers.find(x=>x.id===vId);
    setMngImportErr('');setMngImporting(vId);setMngImportProg([0,0]);
    try{
      await importBblxFile({file,label:v?.label||'',lang:v?.lang||'EN',userId:user?.id,existingVersionId:vId,onProgress:(d,t)=>setMngImportProg([d,t])});
      setMngLocalAvail(a=>({...a,[vId]:true}));
    }catch(e){setMngImportErr(e.message);}
    finally{setMngImporting(null);}
  }

  // ── Reading state (persistent in tab, not modal) ──
  const[readBook,setReadBook]=useState(()=>{try{return Number(localStorage.getItem('scrip:readBook'))||1;}catch{return 1;}});
  const[readCh,setReadCh]=useState(()=>{try{return Number(localStorage.getItem('scrip:readCh'))||1;}catch{return 1;}});
  const[readVid,setReadVid]=useState(null); // set after data loads
  const[readVerses,setReadVerses]=useState([]);
  const[readSelVerses,setReadSelVerses]=useState(()=>new Set()); // multi-select
  // Every highlight the reader has, and this chapter's as verse -> colour.
  const[highlights,setHighlights]=useState([]); // [{version_id,book_num,chapter,verse,color,created_at}]
  const[hlPickerOpen,setHlPickerOpen]=useState(false);
  const chapterHL=useMemo(()=>{const m={};for(const h of highlights)if(h.version_id===readVid&&h.book_num===readBook&&h.chapter===readCh)m[h.verse]=h.color;return m;},[highlights,readVid,readBook,readCh]);
  const[stripOpen,setStripOpen]=useState(false);
  const[stripClosing,setStripClosing]=useState(false);
  const[copyHover,setCopyHover]=useState(false);
  const[bmHover,setBmHover]=useState(false);
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
  const verseTouchStartY=useRef(0);
  const readScrollToVerse=useRef(null);
  // Set by a search result on its way out, read by whichever landing runs. A
  // result lands you on the verse lit but with no strip: you are reading down a
  // list of matches, and a panel over the text on every one of them is in the
  // way of the thing you came to look at. The other arrivals — a typed
  // reference, a cross-reference, a bookmark — are single deliberate acts, and
  // they still open it. Consumed wherever it is read, so it cannot carry into a
  // later arrival that never asked for it.
  const landSilent=useRef(false);
  // Retires an in-flight landing. Anything that starts a new one, or that
  // changes the chapter under an old one, bumps this.
  const landSeq=useRef(0);
  const[bmDialog,setBmDialog]=useState(null);
  const[planStrip,setPlanStrip]=useState(null);
  const planStripRef=useRef(null);
  const verseStripRef=useRef(null);
  const[verseStripH,setVerseStripH]=useState(0);
  const[planStripH,setPlanStripH]=useState(0);
  const readPendingSelVerses=useRef(null); // Set of verse numbers to select after chapter loads
  const prevReadStateRef=useRef({vid:null,book:null,ch:null}); // track previous vid/book/ch for version-change detection
  // A verse selected by arriving at it is provisional. It is there to show you
  // where you landed, not because you picked it — so it goes when you leave the
  // page, and the first verse you tap by hand replaces it rather than joining
  // it. Without that the verse you were sent to lingers, every later tap adds to
  // a selection you never made, and you end up looking at three highlighted
  // verses across two jumps wondering which one you asked for. Verses you choose
  // yourself still multi-select exactly as before: the flag is only ever up
  // between arriving somewhere and touching anything.
  const autoSel=useRef(false);
  function clearAutoSel(){if(!autoSel.current)return;autoSel.current=false;setReadSelVerses(new Set());setStripOpen(false);}
  // Light a verse and centre it. quiet leaves the copy/bookmark strip shut:
  // some landings are a destination you asked for, and some are just where a
  // link happened to put you.
  function landOnVerse(v,quiet){
    const mine=++landSeq.current;
    let tries=0;
    const go=()=>{
      if(mine!==landSeq.current)return;
      const el=document.getElementById(`rv-${v}`);
      if(!el&&tries++<20){setTimeout(go,40);return;}
      if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
      setReadSelVerses(new Set([v]));
      if(!quiet)setStripOpen(true);
      autoSel.current=true;
    };
    setTimeout(go,80);
  }
  // Following a reading, from the plan or from the strip. Passing items adopts
  // that day; passing none keeps the day already on screen, so hopping between
  // its passages does not reset the ticks.
  function openPlanPassage(bk,ch,vs,day,items){
    const tv=vs||1;
    if(items)setPlanStrip(p=>(p&&p.day===day)?p:{day,items,done:[]});
    if(readBook===bk&&readCh===ch){readScrollToVerse.current=null;landOnVerse(tv,true);}
    else{readScrollToVerse.current=tv;landSilent.current=true;setReadBook(bk);setReadCh(ch);}
    setTab('read');
  }
  // The strip slides away before the selection clears. A verse tapped during
  // that slide used to be wiped by it -- lit for a moment, then gone -- so a
  // tap now cancels the pending clear and starts a fresh selection instead.
  const stripDismissT=useRef(null);
  function dismissStrip(){setHlPickerOpen(false);setCopyHover(false);setBmHover(false);setStripClosing(true);clearTimeout(stripDismissT.current);stripDismissT.current=setTimeout(()=>{stripDismissT.current=null;setReadSelVerses(new Set());setStripOpen(false);setStripClosing(false);},160);}
  function cancelDismiss(){if(!stripDismissT.current)return false;clearTimeout(stripDismissT.current);stripDismissT.current=null;setStripClosing(false);return true;}
  function openStrip(v){if(readFullScreen.current)exitFullScreen();setCopyHover(false);setBmHover(false);const fresh=cancelDismiss()||autoSel.current;autoSel.current=false;setReadSelVerses(s=>{const ns=fresh?new Set():new Set(s);ns.add(v);return ns;});setStripOpen(true);}
  // A tap is decided by the click iOS sends, not by touchend. The two used to
  // disagree: touchend called a finger that drifted 8px a scroll and did
  // nothing, while iOS still called it a tap and flashed the verse; and a click
  // that arrived after the 300ms guard (a Strong's chapter re-rendering) toggled
  // the verse a second time, undoing the first. Either way the verse flickered
  // and stayed as it was. iOS sends no click for a scroll, or for a touch that
  // stops one, so the click alone is the right test. Touch still owns the long
  // press, and the click that follows one is ignored.
  function verseTouchStart(v,e){longPressFired.current=false;_wlpFired=false;verseTouchStartY.current=e.touches[0].clientY;if(!_wlpActive&&!audioPlaying){longPressTimer.current=setTimeout(()=>{longPressFired.current=true;longPressTimer.current=null;openStrip(v);},500);}}
  function verseTouchMove(e){if(Math.abs(e.touches[0].clientY-verseTouchStartY.current)>8){if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}}}
  function handleVerseToggle(v){autoSel.current=false;const willEmpty=readSelVerses.has(v)&&readSelVerses.size===1;setReadSelVerses(s=>{const ns=new Set(s);ns.has(v)?ns.delete(v):ns.add(v);return ns;});if(willEmpty&&stripOpen)dismissStrip();}
  function verseTouchEnd(){if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}}
  function verseClick(v){if(longPressFired.current||_wlpFired)return;if(audioPlaying)return;if(readFullScreen.current)exitFullScreen();if(readSelVerses.has(v)&&stripOpen&&!stripDismissT.current)handleVerseToggle(v);else openStrip(v);}
  // Leaving the reading page is leaving it: anything the navigation lit goes
  // with it, so coming back does not find an old jump still highlighted.
  useEffect(()=>{if(tab!=='read')clearAutoSel();},[tab]);
  useEffect(()=>{if(readFullScreen.current)exitFullScreen();},[tab]);
  const[readBmLabel,setReadBmLabel]=useState('');
  const[readBmCat,setReadBmCat]=useState('');
  const[readBmLabelFocused,setReadBmLabelFocused]=useState(false);
  const[readBmOk,setReadBmOk]=useState(false);
  const[readCopyOk,setReadCopyOk]=useState(false);
  const[readSearchQ,setReadSearchQ]=useState('');
  const[readSearchRes,setReadSearchRes]=useState(null);
  const[readSearchResQ,setReadSearchResQ]=useState(''); // the query the standing results belong to
  const[readSearchResultsOpen,setReadSearchResultsOpen]=useState(false);
  const[readSearchOccurrences,setReadSearchOccurrences]=useState(0);
  const[readSearchLimit,setReadSearchLimit]=useState(50);
  const[readSearchCapped,setReadSearchCapped]=useState(false); // a live set that stopped at a page boundary
  const searchSeqRef=useRef(0);      // only the newest search may write results
  const localVersesRef=useRef(null); // {key,rows} — the downloaded version, kept in memory between keystrokes
  const readSearchTimer=useRef(null);
  // Live results follow typing and nothing else. Set when the reader edits the
  // field, cleared when they commit or clear it — so setting the query from a
  // recent-search chip does not start a second search behind the one it ran.
  const searchTypedRef=useRef(false);
  const[searchFieldOpen,setSearchFieldOpen]=useState(false); // is the query field expanded in the bar
  const[searchClosing,setSearchClosing]=useState(false); // the bar is lifting back out
  const searchCloseTimer=useRef(null);
  const searchBarRef=useRef(null);
  const[searchBarH,setSearchBarH]=useState(0); // measured: the bar grows a row when the field opens
  const[searchTopBook,setSearchTopBook]=useState(null); // book the result list is currently showing
  const searchBookRaf=useRef(0);
  // Which book the results are scrolled to is the bar's label; this is the
  // wheel that changes it.
  const[bookWheelOpen,setBookWheelOpen]=useState(false);
  const bookLabelRef=useRef(null);
  // The wheel stands exactly where this label is, so its box is measured rather
  // than derived: the label is the last line of a bar whose height already
  // varies with the filters and the counts row.
  const[bookLabelBox,setBookLabelBox]=useState(null);
  const[searchFiltersOpen,setSearchFiltersOpen]=useState(false);
  const searchInputRef=useRef(null);
  // The magnifier fills gold as the search goes out and then lets go, so the
  // gold means "that registered" rather than sitting on permanently. Driven
  // from doReadSearch, so a tap, Enter and a recent-search chip all show it.
  const[searchFlash,setSearchFlash]=useState(false);
  const searchFlashTimer=useRef(null);
  function flashSearch(){
    setSearchFlash(true);
    clearTimeout(searchFlashTimer.current);
    searchFlashTimer.current=setTimeout(()=>setSearchFlash(false),260);
  }
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
  const versionContentRef=useRef(null);
  const[versionSheetH,setVersionSheetH]=useState(null);
  useEffect(()=>{
    if(readMobileSheet!=='nav')return;
    requestAnimationFrame(()=>{
      if(navContentRef.current){
        // Everything the panel holds besides the content: the body's own padding
        // (20 above, 32 below), the grab strip at the foot of it, and the gold
        // rule under that. This counted 40 against an actual 71, so the sheet was
        // always ~30px shorter than what it held — which left the body forever a
        // little bit scrollable, and its bottom fade forever switched on.
        const h=navContentRef.current.scrollHeight+20+32+16+3;
        const maxH=window.innerHeight-navH-50;
        setNavSheetH(Math.min(h,maxH));
      }
    });
  },[navStep,navPickedBk,navPickedCh,readMobileSheet]);
  useEffect(()=>{
    if(readMobileSheet!=='version')return;
    requestAnimationFrame(()=>{
      if(versionContentRef.current){
        const h=versionContentRef.current.scrollHeight+8+32;
        const maxH=window.innerHeight-navH-50;
        setVersionSheetH(Math.min(h,maxH));
      }
    });
  },[versionSheetView,readMobileSheet]);
  const[settingsAppOpen,setSettingsAppOpen]=useState(false);
  const[audioSettingsOpen,setAudioSettingsOpen]=useState(false);
  const[deleteAccountConfirm,setDeleteAccountConfirm]=useState(false);
  const[offlineDataOpen,setOfflineDataOpen]=useState(false);
  const[readFontSize,setReadFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:fontSize'))||AD.fontSize;}catch{return AD.fontSize;}});
  // Read separately from the reading size: a comfortable verse and a comfortable
  // set of labels are not the same want. 100 means the interface it shipped with.
  const[uiSize,setUiSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:uiSize'))||AD.uiSize;}catch{return AD.uiSize;}});
  const[parallelFontSize,setParallelFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:parallelFontSize'))||16;}catch{return 16;}});
  const[readLineHeight,setReadLineHeight]=useState(()=>{try{return Number(localStorage.getItem('scrip:lineHeight'))||AD.lineHeight;}catch{return AD.lineHeight;}});
  const[readFontFamily,setReadFontFamily]=useState(()=>{try{return localStorage.getItem('scrip:fontFamily')||AD.fontFamily;}catch{return AD.fontFamily;}});
  const[readVerseNums,setReadVerseNums]=useState(()=>{try{return localStorage.getItem('scrip:verseNums')||AD.verseNums;}catch{return AD.verseNums;}});
  const[readTextAlign,setReadTextAlign]=useState(()=>{try{return localStorage.getItem('scrip:textAlign')||AD.textAlign;}catch{return AD.textAlign;}});
  const[readParaMode,setReadParaMode]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:paraMode'))===true;}catch{return AD.paraMode;}});
  const[readRedLetter,setReadRedLetter]=useState(()=>{try{const v=localStorage.getItem('scrip:redLetter');return v===null?AD.redLetter:JSON.parse(v)===true;}catch{return AD.redLetter;}});
  // accent and accentCustom persist through their own effects, so setting the
  // state is enough for those two. Everything else is written inline by the
  // control that owns it, so the reset has to write those keys itself.
  function resetAppearance(){
    setAccent(AD.accent);setCustomAccentHex(AD.accentCustom);
    setReadFontSize(AD.fontSize);setUiSize(AD.uiSize);setReadLineHeight(AD.lineHeight);
    setReadFontFamily(AD.fontFamily);setReadVerseNums(AD.verseNums);setReadTextAlign(AD.textAlign);
    setReadParaMode(AD.paraMode);setReadRedLetter(AD.redLetter);
    try{
      localStorage.setItem('scrip:fontSize',AD.fontSize);
      localStorage.setItem('scrip:uiSize',AD.uiSize);
      localStorage.setItem('scrip:lineHeight',AD.lineHeight);
      localStorage.setItem('scrip:fontFamily',AD.fontFamily);
      localStorage.setItem('scrip:verseNums',AD.verseNums);
      localStorage.setItem('scrip:textAlign',AD.textAlign);
      localStorage.setItem('scrip:paraMode',JSON.stringify(AD.paraMode));
      localStorage.setItem('scrip:redLetter',JSON.stringify(AD.redLetter));
    }catch{}
  }
  const[readAutoFullscreen,setReadAutoFullscreen]=useState(()=>{try{const v=localStorage.getItem('scrip:autoFullscreen');return v===null?true:JSON.parse(v)===true;}catch{return true;}});
  // ── Audio playback state ──
  const[audioSource,setAudioSource]=useState(()=>{try{return localStorage.getItem('scrip:audio:source')||'auto';}catch{return 'auto';}});
  const[audioPlaying,setAudioPlaying]=useState(false);
  const[audioLoaded,setAudioLoaded]=useState(false);
  const[audioLoading,setAudioLoading]=useState(false);
  const[audioError,setAudioError]=useState(null);
  const[audioCheckStatus,setAudioCheckStatus]=useState(null);
  const[otInstalled,setOtInstalled]=useState(()=>localStorage.getItem('scrip:audio:otInstalled')==='true');
  const[ntInstalled,setNtInstalled]=useState(()=>localStorage.getItem('scrip:audio:ntInstalled')==='true');
  const[audioImport,setAudioImport]=useState(null);
  const[showKjvAudioPrompt,setShowKjvAudioPrompt]=useState(false);
  const[kjvPromptNoShow,setKjvPromptNoShow]=useState(false);
  const[currentVerse,setCurrentVerse]=useState(null);
  const[audioRate,setAudioRate]=useState(()=>{try{return Number(localStorage.getItem('scrip:audio:rate'))||1;}catch{return 1;}});
  const[audioAutoScroll,setAudioAutoScroll]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:autoScroll')??'true');}catch{return true;}});
  const[audioAutoAdvance,setAudioAutoAdvance]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:autoAdvance')??'true');}catch{return true;}});
  const[audioKeepAwake,setAudioKeepAwake]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:keepAwake')??'true');}catch{return true;}});
  const[audioInfoOpen,setAudioInfoOpen]=useState(null); // 'scroll'|'advance'|null
  const[voicesByVersion,setVoicesByVersion]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:voices')||'{}');}catch{return {};}});
  // ── Other Resources ──
  const[resources,setResources]=useState([]);
  const[openResId,setOpenResId]=useState(null);
  const[openResData,setOpenResData]=useState(null);
  const[openResChapter,setOpenResChapter]=useState(0);
  const[resImporting,setResImporting]=useState(false);
  const[resImportErr,setResImportErr]=useState('');
  const[resNote,setResNote]=useState('');
  // ── Multi-format resources per section ──
  const[userMaps,setUserMaps]=useState([]);
  const[userCharts,setUserCharts]=useState([]);
  const[userLexicons,setUserLexicons]=useState([]);
  const[userDicts,setUserDicts]=useState([]);
  const[activeLexiconId,setActiveLexiconId]=useState(()=>{try{return localStorage.getItem('scrip:activeLexId')||null;}catch{return null;}});
  const[activeDictId,setActiveDictId]=useState(()=>{try{return localStorage.getItem('scrip:activeDictId')||null;}catch{return null;}});
  const[activeLexData,setActiveLexData]=useState(null);
  const[activeDictData,setActiveDictData]=useState(null);
  const[viewingBlob,setViewingBlob]=useState(null); // {url,title,kind,id}
  const[mapsImporting,setMapsImporting]=useState(false);
  const[mapsImportErr,setMapsImportErr]=useState('');
  const[chartsImporting,setChartsImporting]=useState(false);
  const[chartsImportErr,setChartsImportErr]=useState('');
  const[lexImporting,setLexImporting]=useState(false);
  const[lexImportErr,setLexImportErr]=useState('');
  const[lexSearchQ,setLexSearchQ]=useState('');
  const[lexOpenEntry,setLexOpenEntry]=useState(null);
  const[dictImporting,setDictImporting]=useState(false);
  const[dictImportErr,setDictImportErr]=useState('');
  const[availableVoices,setAvailableVoices]=useState(()=>TTS.getVoices());
  const readFullScreen=useRef(false);
  const fsTransitioning=useRef(false);
  const[fsActive,setFsActive]=useState(false);
  const chLineRef=useRef(null);
  const[chLineAbove,setChLineAbove]=useState(false);
  const safeAreaTopRef=useRef(0);
  const bottomBarRef=useRef(null);
  const headerAnimRef=useRef(null);
  const bottomAnimRef=useRef(null);
  function enterFullScreen(){
    if(readFullScreen.current||fsTransitioning.current)return;
    readFullScreen.current=true;fsTransitioning.current=true;setFsActive(true);
    if(headerAnimRef.current){headerAnimRef.current.cancel();headerAnimRef.current=null;}
    if(bottomAnimRef.current){bottomAnimRef.current.cancel();bottomAnimRef.current=null;}
    const h=navRef.current,b=bottomBarRef.current;
    if(h){h.style.willChange='transform';headerAnimRef.current=h.animate([{transform:'translateY(0)'},{transform:'translateY(-100%)'}],{duration:180,easing:'ease-in',fill:'forwards'});}
    // Not while search has already sent it away: its own transform is holding
    // it off-screen, and a WAAPI animation with fill:forwards outranks an inline
    // style. Animating it here would hand the bar to fullscreen, and leaving
    // fullscreen would then slide it back up over the results.
    if(b&&!readingHidden){b.style.willChange='transform';bottomAnimRef.current=b.animate([{transform:'translateY(0)'},{transform:'translateY(100%)'}],{duration:180,easing:'ease-in',fill:'forwards'});}
    setTimeout(()=>{fsTransitioning.current=false;},180);
  }
  function exitFullScreen(){
    if(!readFullScreen.current||fsTransitioning.current)return;
    readFullScreen.current=false;fsTransitioning.current=true;setFsActive(false);
    if(headerAnimRef.current){headerAnimRef.current.cancel();headerAnimRef.current=null;}
    if(bottomAnimRef.current){bottomAnimRef.current.cancel();bottomAnimRef.current=null;}
    const h=navRef.current,b=bottomBarRef.current;
    if(h){h.style.willChange='transform';const a=h.animate([{transform:'translateY(-100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>{a.cancel();h.style.willChange='';}}
    if(b&&!readingHidden){b.style.willChange='transform';const a=b.animate([{transform:'translateY(100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>{a.cancel();b.style.willChange='';}}
    setTimeout(()=>{fsTransitioning.current=false;},180);
  }
  const lastScrollY=useRef(0);
  const scrollDelta=useRef(0);
  const fsScrollThreshold=30;
  const scrollbarThumbRef=useRef(null);
  const scrollbarHideTimer=useRef(null);
  const keepSearchResRef=useRef(false); // prevent clearing results when navigating from a search result
  const searchResultScrollRef=useRef(0); // saved scroll pos of results list
  const readViewScrollRef=useRef(0);    // saved scroll pos of reading view
  const scrollRafPending=useRef(false);
  const autoScrollUntil=useRef(0); // reading along scrolls the pane itself; ignore those events
  const scrollPendingState=useRef(null);
  function handleReadScroll(e){
    const el=e.target;const sy=el.scrollTop;const dy=sy-lastScrollY.current;lastScrollY.current=sy;
    // Fullscreen logic runs immediately (no RAF needed — it doesn't touch layout)
    // Scrolling to keep up with the voice fires the same events a finger does,
    // and a smooth scroll fires a stream of them in both directions as it
    // settles. They were accumulating into the threshold below and hiding the
    // top bar on their own, mid-chapter and often mid-Settings.
    if(Date.now()<autoScrollUntil.current){scrollDelta.current=0;}
    else if(sy<=5){if(readFullScreen.current)exitFullScreen();scrollDelta.current=0;}
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
  // This panel keeps its animation in a style prop rather than a class, so React
  // would write over the hook's override on the next render. One flag, set as the
  // drag begins, keeps the two agreeing.
  const[strongsDragMode,setStrongsDragMode]=useState(false);
  const closeStrongsPopup=React.useCallback(()=>{
    setStrongsClosing(true);
    setTimeout(()=>{
      setStrongsPopup(null);setStrongsVersePreview(null);setStrongsClosing(false);
      setStrongsDragMode(false);
    },260);
  },[]);
  const{ref:strongsPanelRef,handlers:strongsDragHandlers}=useSheetDrag(1,closeStrongsPopup,()=>setStrongsDragMode(true),()=>setStrongsDragMode(false));
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
  // Walkthrough clip is optional: only offer it if public/help/fcbh-audio.mp4 exists.
  const[audioHelpVideo,setAudioHelpVideo]=useState(null);
  useEffect(()=>{
    let stop=false;
    // Content type rather than response.ok: a dev server, and some static hosts,
    // answer an unknown path with the SPA index.html at 200, which would advertise
    // a walkthrough that isn't there.
    const looksLikeVideo=r=>r&&r.ok&&/^video\//i.test(r.headers.get('content-type')||'');
    // .mov as well as .mp4 — QuickTime's Export As writes .mov, and it is the
    // no-install way to produce one of these on a Mac.
    (async()=>{
      for(const ext of ['mp4','mov']){
        if(stop)return;
        const url=`${BUNDLED_BASE}help/fcbh-audio.${ext}`;
        try{
          if(looksLikeVideo(await fetch(url,{method:'HEAD'}))){
            if(!stop)setAudioHelpVideo(url);
            return;
          }
        }catch{}
        // Capacitor serves the web layer through its own URL scheme handler, which
        // is built around GET; a HEAD can come back missing the headers above. Ask
        // for one byte instead — enough to identify the file, cheap either way.
        try{
          if(looksLikeVideo(await fetch(url,{headers:{Range:'bytes=0-0'}}))){
            if(!stop)setAudioHelpVideo(url);
            return;
          }
        }catch{}
      }
    })();
    return()=>{stop=true;};
  },[]);
  const dlAbort=useRef({});

  // Reads what is actually in IndexedDB. Called on mount and again once the
  // shipped-data install finishes — that install takes ~10s, so a mount-time
  // read alone leaves every row showing "Download" for data already present,
  // and tapping one starts a pointless network download.
  async function refreshDownloadStates(){
      await ensureStrongsDownloadFresh().catch(()=>{});
      const ids=[...PUBLIC_VERSIONS.map(pv=>pv.id),'strongs','webster'];
      // Strong's counts as downloaded only once every phase is in. Keying off the
      // lexicon flag alone showed a complete tick while mapping and occurrences
      // were still missing, and offered to delete instead of resume.
      const checks=await Promise.all(ids.map(async id=>({id,downloaded:await idbIsDownloaded(id==='strongs'?'strongsocc':id).catch(()=>false)})));
      const map={};for(const c of checks)map[c.id]={downloaded:c.downloaded};
      setDlStates(prev=>{
        // Don't clobber a download that is running right now.
        const next={...map};
        for(const k of Object.keys(prev||{}))if(prev[k]&&prev[k].downloading)next[k]={...next[k],...prev[k]};
        return next;
      });
  }
  useEffect(()=>{refreshDownloadStates();},[]);

  function setDlState(vid,patch){setDlStates(prev=>({...prev,[vid]:{...(prev[vid]||{}), ...patch}}));}
  // iOS suspends the WebView shortly after the screen locks, which stops a download
  // mid-flight. Hold a screen wake lock for as long as one is running.
  const anyDownloading=Object.values(dlStates).some(s=>s&&s.downloading);
  useEffect(()=>{
    if(!anyDownloading||!('wakeLock' in navigator))return;
    let lock=null;
    const acquire=async()=>{try{lock=await navigator.wakeLock.request('screen');}catch{}};
    const onVis=()=>{if(document.visibilityState==='visible')acquire();};
    acquire();
    document.addEventListener('visibilitychange',onVis);
    return()=>{document.removeEventListener('visibilitychange',onVis);lock?.release().catch(()=>{});};
  },[anyDownloading]);

  async function startDownload(vid){
    if(dlAbort.current[vid])dlAbort.current[vid].abort();
    const ctrl=new AbortController();
    dlAbort.current[vid]=ctrl;
    const initTotal=vid==='strongs'?1454066:vid==='webster'?107793:31102;
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

  const[confirmDeleteDl,setConfirmDeleteDl]=useState(null);
  const[planState,setPlanState]=useState(()=>planLoad());
  const planTodayRef=useRef(null);
  const[planRemind,setPlanRemind]=useState(()=>planRemindLoad());
  const[planRemindBusy,setPlanRemindBusy]=useState(false);
  const[planRemindMsg,setPlanRemindMsg]=useState('');
  // {value,onSet} while the time picker is up.
  const[timePicker,setTimePicker]=useState(null);
  // The language the reader is actually in. versionLang only knows the built-in
  // versions, so anything imported came back as English however it was tagged.
  const readLang=useMemo(()=>String((data?.versions||[]).find(v=>v.id===readVid)?.lang||versionLang(readVid)||'EN'),[data,readVid]);
  // Top up the month's worth of reminders each time the plan is opened, so they
  // never run dry and always carry the right passages. The book names are baked
  // into each notification when it is scheduled, so a change of version has to
  // rewrite them — otherwise tomorrow's reminder arrives in the language the
  // reader happened to be in when the reminder was first switched on.
  const planSyncedRef=useRef('');
  useEffect(()=>{
    if(!planRemind.on)return;
    const key=planRemind.time+'|'+readLang;
    // Opening the plan always tops the window up; otherwise only a change of
    // language is worth rewriting thirty notifications for.
    if(modal?.type!=='plan'&&planSyncedRef.current===key)return;
    planSyncedRef.current=key;
    planSyncReminders(true,planRemind.time,new Date().getFullYear(),readLang);
  },[modal,readLang]);
  function planToggleDay(day){
    setPlanState(prev=>{
      const set=new Set(prev.done);
      set.has(day)?set.delete(day):set.add(day);
      const next={...prev,done:[...set].sort((a,b)=>a-b)};
      planSave(next);
      return next;
    });
  }
  // Open the plan with today mid-screen, so the days behind you are a scroll up
  // and the days ahead a scroll down.
  useEffect(()=>{
    if(modal?.type!=='plan')return;
    // Not requestAnimationFrame: it does not fire while the page is hidden or
    // backgrounded, and the centring would silently never happen.
    const t=setTimeout(()=>{
      const el=planTodayRef.current;if(!el)return;
      const sc=el.closest('.modal-body');if(!sc)return;
      const r=el.getBoundingClientRect(),sr=sc.getBoundingClientRect();
      sc.scrollTop+=(r.top-sr.top)-(sc.clientHeight-r.height)/2;
    },40);
    return()=>clearTimeout(t);
  },[modal]);
  function dlDisplayName(vid){
    if(vid==='strongs')return "Strong's Concordance";
    if(vid==='webster')return "Webster's 1828 Dictionary";
    const pv=PUBLIC_VERSIONS.find(p=>p.id===vid);
    return (pv&&pv.label)||String(vid).toUpperCase();
  }
  // Re-downloading Strong's is a long job, so deletion asks first rather than
  // firing on a single stray tap.
  function deleteDownload(vid){setConfirmDeleteDl(vid);}
  async function doDeleteDownload(vid){
    if(vid==='strongs'){await idbClearStrongs().catch(()=>{});await idbPutMeta('dl:strongs',false);await idbPutMeta('dl:strongsmap',false);await idbPutMeta('dl:strongsocc',false);}
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
  const [bottomBarH,setBottomBarH]=useState(0);
  // The install screen replaces the whole tree rather than covering it, so what
  // was measured from the mounted app -- both bars, the chapter on screen -- is
  // stale when the tree comes back. Declared up here so those effects can
  // depend on it: an update that bumps a bundled dataset put a signed-in user
  // straight into that swap, and left every sheet hidden under the nav.
  const[bundledInstall,setBundledInstall]=useState(null); // {done,total}
  const installing=!!(bundledInstall&&bundledInstall.total>0);
  useEffect(()=>{if(installing)bootMark('install-screen');},[installing]);
  useEffect(()=>{if(ready)bootMark('ready');},[ready]);
  const swipeTouchX=useRef(null);
  const swipeTouchY=useRef(null);
  const swipeTouchT=useRef(null);
  const swipeDir=useRef(null); // null|'h'|'v'
  const readSearchJumpTo=useRef(null);
  const audioElRef=useRef(null);
  const kjvPromptShownRef=useRef(false);
  // Create the audio element imperatively so it is always in the DOM regardless
  // of which tab is active. useLayoutEffect runs before passive useEffects, so
  // audioElRef.current is guaranteed non-null when the listener effect runs.
  const audioRateRef=useRef(1); // read by the listener below, which outlives any render
  useLayoutEffect(()=>{
    const el=document.createElement('audio');
    el.style.display='none';
    document.body.appendChild(el);
    audioElRef.current=el;
    // Loading a source resets playbackRate to defaultPlaybackRate — so the rate
    // has to be put back on the element every time a chapter loads, not only
    // when the reader moves the slider.
    const reapply=()=>{const r=audioRateRef.current||1;el.defaultPlaybackRate=r;el.playbackRate=r;};
    el.addEventListener('loadedmetadata',reapply);
    el.addEventListener('play',reapply);
    return()=>{el.removeEventListener('loadedmetadata',reapply);el.removeEventListener('play',reapply);el.remove();};
  },[]);
  const audioTimestampsRef=useRef(null);
  const audioUtterRef=useRef([]);
  const audioModeRef=useRef(null); // tracks what is actually playing: 'fcbh'|'local'|'speech'|null
  const currentVerseRef=useRef(null); // mirror of currentVerse for use inside event handlers
  const autoAdvancePendingRef=useRef(false); // set before chapter change so new chapter auto-starts
  // Local playback needs the pack for the book actually in hand. Guarding only
  // the "auto" branch was not enough — choosing KJV Audio explicitly (which the
  // audio prompt's Go to Settings now does for you) walked straight past it, and
  // playback died silently on a file that was never there.
  function audioSrcFor(src){
    if(src!=='local')return src;
    // The pack is a reading of the KJV, so no other version may use it —
    // picking KJV Audio and then switching Bible left it reading the wrong
    // translation aloud. Auto already resolved this correctly; now the
    // explicit choice does too.
    if(readVid!=='kjv')return 'speech';
    return (readBook<=39?otInstalled:ntInstalled)?'local':'speech';
  }
  const loadChapterAudioRef=useRef(null); // always points to latest loadChapterAudio (avoids stale closures)
  const handleNextChapterRef=useRef(null); // same, for the 'ended' listener bound once per audio settings change
  const msBookRef=useRef(readBook);
  const msChRef=useRef(readCh);
  useEffect(()=>{msBookRef.current=readBook;},[readBook]);
  useEffect(()=>{msChRef.current=readCh;},[readCh]);

  // ── Parallel Verses state ──
  // ── Commentaries ──
  // Its own place in the Bible, set from Read each time the page is opened, so
  // its arrows can wander without moving the chapter you are reading.
  const[cmImports,setCmImports]=useState([]);
  const[cmId,setCmId]=useState(()=>{try{return localStorage.getItem('scrip:cmId')||TSKE_ID;}catch{return TSKE_ID;}});
  const[cmBook,setCmBook]=useState(1);
  const[cmCh,setCmCh]=useState(1);
  const[cmFocus,setCmFocus]=useState(null);
  useEffect(()=>{idbListCommentaries().then(l=>setCmImports(l.sort((a,b)=>b.importedAt-a.importedAt))).catch(()=>{});},[]);
  useEffect(()=>{try{localStorage.setItem('scrip:cmId',cmId);}catch{}},[cmId]);
  const cmList=useMemo(()=>[TSKE,...cmImports],[cmImports]);
  const[parallelVids,setParallelVids]=useState([]);
  const[parallelBk,setParallelBk]=useState(1);
  const[parallelCh,setParallelCh]=useState(1);
  const[parallelVs,setParallelVs]=useState(1);
  const[parallelChapters,setParallelChapters]=useState({});
  const[parallelLoading,setParallelLoading]=useState(false);
  const[parallelMobileSheet,setParallelMobileSheet]=useState(null);
  // The Strong's panel belongs to the word it was opened from. Anything else
  // that takes the screen -- a sheet, a menu, a dialog -- stands it down, the
  // way search always has; otherwise it sat over whatever was opened. Keyed on
  // the menus only, so it acts as one opens and never fights the panel itself.
  useEffect(()=>{
    if(strongsPopup&&(readMobileSheet||mobileSheet||modal||parallelMobileSheet))closeStrongsPopup();
  },[readMobileSheet,mobileSheet,modal,parallelMobileSheet]);
  // The utterance callbacks are built once per chapter, so they would otherwise
  // go on seeing whatever was open at the moment playback started. A ref read at
  // call time sees what is open now.
  const anySheetOpenRef=useRef(false);
  anySheetOpenRef.current=!!(readMobileSheet||mobileSheet||modal||parallelMobileSheet);
  // Catch up once the sheet closes, so the reader is where the voice is.
  useEffect(()=>{
    if(anySheetOpenRef.current||!audioPlaying||!audioAutoScroll)return;
    const v=currentVerseRef.current;
    if(v!=null)scrollToVerse(v);
  },[readMobileSheet,mobileSheet,modal,parallelMobileSheet]);

  // ── Dictionary state ──
  const[dictSearchQ,setDictSearchQ]=useState('');
  const[dictDbEntries,setDictDbEntries]=useState(null); // [{word,pos,definitions}]
  const[dictDbLoading,setDictDbLoading]=useState(false);
  const[dictLive,setDictLive]=useState(null); // external API fallback
  const[dictLiveLoading,setDictLiveLoading]=useState(false);
  const dictTimerRef=useRef(null);

  // ── Bookmarks / Recents / Categories ──
  const[bookmarks,setBookmarks]=useState([]);
  const[recents,setRecents]=useState([]);
  const[bmCategories,setBmCategories]=useState([]);

  const undoTRef=useRef(null);const undoPRef=useRef(null);
  const _acc=(accent==='custom'?buildCustomPalette(customAccentHex):(ACCENTS[accent]||ACCENTS.gold))[dark?'dark':'light'];
  const T={...(dark?D:L),..._acc,accentLine:`linear-gradient(90deg,transparent,${_acc.gD},${_acc.g},${_acc.gD},transparent)`};

  // ── CSS variable accent injection ──
  useEffect(()=>{
    function hexToRgb(h){const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return`${r},${g},${b}`;}
    const rgb=hexToRgb(T.g||'#c8a84e');
    const rgbD=hexToRgb(T.gD||'#4a3e22');
    const r=document.getElementById('accent-vars')||Object.assign(document.createElement('style'),{id:'accent-vars'});
    r.textContent=`:root{--ac-scrollbar:${T.gD};--ac-mark:rgba(${rgb},0.22);--ac-bd:${T.gD};--ac-ghost-bg:rgba(${rgb},0.09);--ac-ghost-bg-h:rgba(${rgb},0.16);--ac-ghost-bd:rgba(${rgb},0.3);--ac-tbtn-bd:rgba(${rgb},0.5);--ac-tbtn-bg:rgba(${rgb},0.06);--ac-focus:rgba(${rgb},0.4);--ac-pulse0:rgba(${rgb},0);--ac-pulse50:rgba(${rgb},0.25);--ac-shimmer:rgba(${rgb},0.12);--ac-spin-ring:rgba(${rgb},0.2);--ac-spin-top:${T.g};--ac-verse-hover:rgba(${rgb},0.05);--ac-input-bd:rgba(${rgb},0.27);--ac-input-sh:rgba(${rgb},0.08);--ac-audio-bg:rgba(${rgb},0.15);--ac-audio-ring:rgba(${rgb},0.4);--ac-audio-line:rgba(${rgb},0.5);--ac-sel-glow:rgba(${rgb},0.18);--ac-dim:${T.dim};--ac-glass-bg:rgba(${rgb},0.03),rgba(0,0,0,0.45);--ac-scrollbar-read:rgba(${rgb},0.5);}`;
    if(!r.parentNode)document.head.appendChild(r);
  },[T.g,T.gD]);

  // ── Interface scale injection ──
  // Its own <style>, not folded into the accent one above, so it can be pulled
  // without touching the colours. Writing a variable rather than threading a
  // number through the tree means dragging the slider repaints without a
  // re-render, and the nav and bottom bars' ResizeObservers pick up their own
  // new heights on their own.
  useEffect(()=>{
    // Each ramp is written as where it lands at the top of the slider rather
    // than as a compression factor, because that is the thing actually agreed:
    // micro-labels 1.35x, headings 1.5x, everything else 1.6x. Expressed the
    // other way the caps never bound and the interface stopped short of them.
    // Below 100 the same ramps run backwards, so the labels give up the least:
    // at 85% body copy is at 0.85 but a 9px label only reaches 8.2px.
    const t=Math.min(1,Math.max(-0.25,(Math.min(150,Math.max(85,uiSize))-100)/60)),at=hi=>(1+t*(hi-1)).toFixed(4);
    const el=document.getElementById('ui-scale-vars')||Object.assign(document.createElement('style'),{id:'ui-scale-vars'});
    el.textContent=`:root{--ui-s:${at(1.6)};--ui-l:${at(1.35)};--ui-h:${at(1.5)};}`;
    if(!el.parentNode)document.head.appendChild(el);
  },[uiSize]);

  // ── Audio playback functions ──
  const scrollToVerse=(v)=>{
    if(!readRef.current)return;
    const el=readRef.current.querySelector(`[data-verse="${v}"]`);
    if(!el)return;
    // Held open past the smooth scroll's own settling, and pushed forward by
    // each new verse, so the run of events it emits is never read as a gesture.
    autoScrollUntil.current=Date.now()+900;
    el.scrollIntoView({behavior:'smooth',block:'center'});
  };
  // Reading along behind an open sheet scrolls a page nobody can see, and it
  // was that scroll that pulled the top bar out from under whatever was open.
  const audioScrollTo=(v)=>{if(!anySheetOpenRef.current)scrollToVerse(v);};
  const stopAudio=()=>{
    audioModeRef.current=null;currentVerseRef.current=null;
    setAudioLoaded(false);setCurrentVerse(null);
    TTS.cancel();audioUtterRef.current=[];
    if(audioElRef.current){audioElRef.current.pause();audioElRef.current.removeAttribute('src');}
    setAudioPlaying(false);
  };
  const updateMediaSession=(bookNum,ch)=>{
    // Lock-screen metadata is a nicety; a WebView without MediaMetadata used to
    // throw here and take the speak() call on the next line down with it.
    if(!('mediaSession' in navigator)||typeof MediaMetadata!=='function')return;
    const bk=BIBLE[bookNum-1];
    try{
    navigator.mediaSession.metadata=new MediaMetadata({
      title:bk?`${bk.name} ${ch}`:'Scriptorium',
      artist:'Scriptorium',
      album:'The Bible',
    });
    }catch{}
  };
  // Which voice reads this version, in one place — the three speech paths each
  // carried their own copy of this, so every fault below existed in triplicate.
  //  - The language came from a hardcoded pair of version ids, so any Bible the
  //    user imported was read in English whatever language it was actually in.
  //    It comes from the version's own lang now.
  //  - Failing to find a voice for the language fell back to voices[0], which is
  //    all but always an English one. An English voice reading Spanish is worse
  //    than no choice at all, so nothing is chosen and u.lang steers the engine.
  function speechVoiceFor(){
    const voices=TTS.getVoices();
    const code=readLang.toLowerCase().slice(0,2);
    const saved=voicesByVersion[readVid];
    if(saved){
      const s=voices.find(v=>v.name===saved);
      if(s)return{voice:s,lang:s.lang||code};
    }
    const spoken=v=>v.lang&&v.lang.toLowerCase().replace('_','-').startsWith(code);
    const pref=code==='es'?'Paulina':code==='en'?'Daniel':null;
    const match=(pref?voices.find(v=>(v.name===pref||v.name.startsWith(pref+' '))&&spoken(v)):null)
      ||voices.find(v=>spoken(v)&&v.default)
      ||voices.find(spoken);
    return{voice:match||null,lang:match?.lang||code};
  }
  const loadChapterAudio=async(srcOverride=null,startAt=null)=>{
    if(!readVerses||!readVerses.length){setAudioError('No verses loaded');return;}
    setAudioError(null);setAudioLoading(true);
    if(TTS.paused)TTS.resume();TTS.cancel();audioUtterRef.current=[];
    if(audioElRef.current){audioElRef.current.pause();}
    // Only seek if the user explicitly selected a verse; otherwise play from 0 to include chapter intro
    const startVerse=startAt??(readSelVerses.size>0?Math.min(...readSelVerses):null);
    const hasFcbhKey=!!(localStorage.getItem('scrip:audio:fcbhKey')||'').trim();
    const src=audioSrcFor(srcOverride||(audioSource==='auto'
      ?(readVid==='kjv'?'local':DEFAULT_FILESETS[readVid]&&hasFcbhKey?'fcbh':'speech')
      :(audioSource==='off'?null:audioSource)));
    try{
      if(src==='fcbh'){
        audioModeRef.current='fcbh';
        const fs=DEFAULT_FILESETS[readVid];
        if(!fs)throw new Error('FCBH not available for this version');
        const usfm=USFM_CODES[readBook-1];
        const [meta,ts]=await Promise.all([
          fcbhGetChapterUrl(fs,usfm,readCh),
          fcbhGetTimestamps(fs,usfm,readCh).catch(()=>null),
        ]);
        if(!meta||!meta.path)throw new Error('Could not load chapter audio');
        audioElRef.current.src=meta.path;
        audioTimestampsRef.current=ts;
        setAudioLoaded(true);
        if(startVerse&&ts&&ts[startVerse]!==undefined){
          const seekOnLoad=()=>{
            audioElRef.current.currentTime=ts[startVerse];
            audioElRef.current.removeEventListener('loadedmetadata',seekOnLoad);
          };
          audioElRef.current.addEventListener('loadedmetadata',seekOnLoad);
        }
        updateMediaSession(readBook,readCh);
        audioElRef.current.play().catch(()=>{});
        currentVerseRef.current=startVerse;setAudioPlaying(true);setCurrentVerse(startVerse);
      }else if(src==='local'){
        audioModeRef.current='local';
        if(Capacitor.isNativePlatform()){
          const{folder,stem}=localAudioStem(readBook,readCh);
          const nativePath=`Audio/${folder}/KJV Reg/${stem}.mp3`;
          try{
            const result=await Filesystem.getUri({directory:Directory.Documents,path:nativePath});
            audioElRef.current.src=Capacitor.convertFileSrc(result.uri);
          }catch{
            // getUri builds a path without checking it exists, so a missing pack
            // used to sail through to a src that silently never plays. Fall back
            // to speech rather than leaving the button dead.
            setAudioLoading(false);
            loadChapterAudioRef.current?.('speech');
            return;
          }
        }else{
          audioElRef.current.src=localAudioUrl(readBook,readCh);
        }
        audioTimestampsRef.current=null;
        const _tsUrl=localTimestampUrl(readBook,readCh);
        fetch(_tsUrl).then(r=>r.ok?r.json():null).then(ts=>{
          if(ts){
            audioTimestampsRef.current=ts;
            // If loadedmetadata already fired before timestamps arrived, seek now
            if(startVerse&&ts[startVerse]!==undefined&&audioElRef.current&&!audioElRef.current.ended){
              audioElRef.current.currentTime=ts[startVerse];
            }
          }
        }).catch(()=>{});
        setAudioLoaded(true);
        if(startVerse){
          const seekOnLoad=()=>{
            const ts=audioTimestampsRef.current;
            if(ts&&ts[startVerse]!==undefined)audioElRef.current.currentTime=ts[startVerse];
            audioElRef.current.removeEventListener('loadedmetadata',seekOnLoad);
          };
          audioElRef.current.addEventListener('loadedmetadata',seekOnLoad);
        }
        updateMediaSession(readBook,readCh);
        audioElRef.current.play().catch(()=>{});
        currentVerseRef.current=startVerse;setAudioPlaying(true);setCurrentVerse(startVerse);
      }else if(src==='speech'){
        // No speech engine in this browser: say so rather than go quiet.
        if(!TTS_OK){setAudioError('This device has no built-in voice');setAudioLoaded(false);setAudioPlaying(false);return;}
        audioModeRef.current='speech';
        const{voice,lang:uttLang}=speechVoiceFor();
        audioUtterRef.current=[];
        TTS.cancel();
        const startIdx=startVerse?Math.max(0,readVerses.findIndex(v=>v.verse>=startVerse)):0;
        const versesToSpeak=readVerses.slice(startIdx);
        const lastVerse=readVerses[readVerses.length-1]?.verse;
        versesToSpeak.forEach(({verse,text})=>{
          const u=new SpeechUtter(text.replace(/<[^>]+>/g,''));
          u.lang=uttLang;u.rate=audioRate;if(voice)u.voice=voice;
          u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)audioScrollTo(verse);};
          u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
          audioUtterRef.current.push(u);
        });
        setAudioLoaded(true);
        updateMediaSession(readBook,readCh);
        audioUtterRef.current.forEach(u=>TTS.speak(u));
        currentVerseRef.current=startVerse;setAudioPlaying(true);setCurrentVerse(startVerse);
      }else throw new Error('No audio source available');
    }catch(e){
      setAudioError(e.message);
      setAudioLoaded(false);
      setAudioPlaying(false);
    }finally{setAudioLoading(false);}
  };
  loadChapterAudioRef.current=loadChapterAudio;
  const handleNextChapter=()=>{
    const current=BIBLE.find(b=>b.n===readBook);
    if(!current||readCh>=current.v.length){return;}
    autoAdvancePendingRef.current=true;
    setReadCh(readCh+1);
  };
  handleNextChapterRef.current=handleNextChapter;
  const handlePlayPause=async()=>{
    if(audioPlaying){
      audioElRef.current?.pause();
      TTS.pause();
      setAudioPlaying(false);
      if(stripOpen)dismissStrip();
      return;
    }
    const mode=audioModeRef.current;
    if(audioLoaded&&(mode==='fcbh'||mode==='local')){
      if(!audioElRef.current.ended){
        const selVerse=readSelVerses.size>0?Math.min(...readSelVerses):null;
        if(selVerse){
          const ts=audioTimestampsRef.current;
          if(ts&&ts[selVerse]!==undefined){
            audioElRef.current.currentTime=ts[selVerse];
            currentVerseRef.current=selVerse;
            setCurrentVerse(selVerse);
          }
          setReadSelVerses(new Set());
          if(stripOpen)dismissStrip();
        }
        audioElRef.current.play().catch(()=>{});
        setAudioPlaying(true);
      }else{
        await loadChapterAudio();
      }
    }else if(audioLoaded&&mode==='speech'){
      const selVerse=readSelVerses.size>0?Math.min(...readSelVerses):null;
      if(TTS.paused){
        if(selVerse){
          setReadSelVerses(new Set());
          if(stripOpen)dismissStrip();
          seekWebSpeechToVerse(selVerse);
          setAudioPlaying(true);
        }else{
          TTS.resume();
          setAudioPlaying(true);
        }
      }else{
        await loadChapterAudio();
      }
    }else{
      await loadChapterAudio();
    }
  };

  const seekWebSpeechToVerse=(targetVerse)=>{
    const startIdx=readVerses.findIndex(v=>v.verse===targetVerse);
    if(startIdx<0)return;
    audioModeRef.current='speech';
    if(TTS.paused)TTS.resume();TTS.cancel();
    audioUtterRef.current=[];
    const{voice,lang:uttLang}=speechVoiceFor();
    const lastVerse=readVerses[readVerses.length-1]?.verse;
    for(let i=startIdx;i<readVerses.length;i++){
      const {verse,text}=readVerses[i];
      const u=new SpeechUtter(text.replace(/<[^>]+>/g,''));
      u.lang=uttLang;u.rate=audioRate;if(voice)u.voice=voice;
      u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)audioScrollTo(verse);};
      u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
      audioUtterRef.current.push(u);
    }
    audioUtterRef.current.forEach(u=>TTS.speak(u));
    currentVerseRef.current=targetVerse;setCurrentVerse(targetVerse);
    if(audioAutoScroll)audioScrollTo(targetVerse);
  };

  // Called directly from onClick handlers so iOS WKWebView recognises the user gesture
  const doStartSpeech=(startVerse)=>{
    if(!readVerses||!readVerses.length)return;
    audioModeRef.current='speech';
    if(audioElRef.current){audioElRef.current.pause();audioElRef.current.removeAttribute('src');}
    const{voice,lang:uttLang}=speechVoiceFor();
    audioUtterRef.current=[];
    if(TTS.paused)TTS.resume();TTS.cancel();
    const sv=startVerse||(readVerses[0]?.verse||1);
    const startIdx=Math.max(0,readVerses.findIndex(v=>v.verse>=sv));
    const lastVerse=readVerses[readVerses.length-1]?.verse;
    for(let i=startIdx;i<readVerses.length;i++){
      const {verse,text}=readVerses[i];
      const u=new SpeechUtter(text.replace(/<[^>]+>/g,''));
      u.lang=uttLang;u.rate=audioRate;if(voice)u.voice=voice;
      u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)audioScrollTo(verse);};
      u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
      audioUtterRef.current.push(u);
    }
    setAudioLoaded(true);
    updateMediaSession(readBook,readCh);
    audioUtterRef.current.forEach(u=>TTS.speak(u));
    currentVerseRef.current=sv;setAudioPlaying(true);setCurrentVerse(sv);
  };

  // ── Persist prefs ──
  useEffect(()=>{localStorage.setItem('scrip:dark',JSON.stringify(dark));},[dark]);
  useEffect(()=>{try{localStorage.setItem('scrip:accent',accent);}catch{}},[accent]);
  useEffect(()=>{try{localStorage.setItem('scrip:accentCustom',customAccentHex);}catch{}},[customAccentHex]);
  useEffect(()=>{localStorage.setItem('scrip:hidden',JSON.stringify(hiddenVers));},[hiddenVers]);
  useEffect(()=>{try{localStorage.setItem('scrip:readBook',readBook);localStorage.setItem('scrip:readCh',readCh);}catch{}},[readBook,readCh]);
  // ── Persist audio prefs ──
  useEffect(()=>{try{localStorage.setItem('scrip:audio:source',audioSource);}catch{}},[audioSource]);
  useEffect(()=>{try{localStorage.setItem('scrip:audio:rate',audioRate);}catch{}},[audioRate]);
  useEffect(()=>{try{localStorage.setItem('scrip:audio:autoScroll',JSON.stringify(audioAutoScroll));}catch{}},[audioAutoScroll]);
  useEffect(()=>{try{localStorage.setItem('scrip:audio:autoAdvance',JSON.stringify(audioAutoAdvance));}catch{}},[audioAutoAdvance]);
  useEffect(()=>{try{localStorage.setItem('scrip:audio:keepAwake',JSON.stringify(audioKeepAwake));}catch{}},[audioKeepAwake]);
  useEffect(()=>{try{localStorage.setItem('scrip:audio:voices',JSON.stringify(voicesByVersion));}catch{}},[voicesByVersion]);
  // ── Wake lock: prevent screen sleep while audio is playing ──
  useEffect(()=>{
    if(!audioPlaying||!audioKeepAwake||!('wakeLock' in navigator))return;
    let lock=null;
    const acquire=async()=>{try{lock=await navigator.wakeLock.request('screen');}catch{}};
    const onVis=()=>{if(document.visibilityState==='visible')acquire();};
    acquire();
    document.addEventListener('visibilitychange',onVis);
    return()=>{document.removeEventListener('visibilitychange',onVis);lock?.release().catch(()=>{});};
  },[audioPlaying,audioKeepAwake]);
  // ── Stop audio on chapter/version change ──
  useEffect(()=>{stopAudio();},[readVid,readBook,readCh]);
  // Changing the source used to leave whatever was already going to play itself
  // out — the switch only took hold at the next chapter, because that was the
  // only thing that stopped the audio. Swap immediately instead, picking up at
  // the verse being read so the change is a handover rather than a restart.
  const audioSrcFirst=useRef(true);
  useEffect(()=>{
    if(audioSrcFirst.current){audioSrcFirst.current=false;return;}
    const resumeAt=audioPlaying?currentVerseRef.current:null;
    const wasPlaying=audioPlaying;
    stopAudio();
    if(!wasPlaying||audioSource==='off')return;
    loadChapterAudioRef.current?.(null,resumeAt);
  },[audioSource]);
  // ── Measure safe-area-inset-top (lazy — done on first scroll so WKWebView is settled) ──
  function measureSafeAreaTop(){
    const el=document.createElement('div');
    el.style.cssText='position:fixed;top:env(safe-area-inset-top,0px);left:0;width:1px;height:1px;pointer-events:none;visibility:hidden;';
    document.body.appendChild(el);
    const v=el.getBoundingClientRect().top;
    document.body.removeChild(el);
    return v;
  }
  // ── Chapter line pin: reset when chapter changes ──
  useEffect(()=>{setChLineAbove(false);},[readBook,readCh]);
  // ── Auto-advance: start next chapter once its verses are loaded ──
  useEffect(()=>{
    if(!autoAdvancePendingRef.current||!readVerses||!readVerses.length)return;
    autoAdvancePendingRef.current=false;
    loadChapterAudio();
  },[readVerses]);
  // ── Media Session lock-screen controls ──
  useEffect(()=>{
    if(!('mediaSession' in navigator))return;
    navigator.mediaSession.setActionHandler('play',()=>{audioElRef.current?.play().catch(()=>{});setAudioPlaying(true);});
    navigator.mediaSession.setActionHandler('pause',()=>{audioElRef.current?.pause();TTS.pause();setAudioPlaying(false);});
  },[]);
  useEffect(()=>{
    if(!('mediaSession' in navigator))return;
    const current=BIBLE.find(b=>b.n===readBook);
    navigator.mediaSession.setActionHandler('nexttrack',current&&readCh<current.v.length?()=>{autoAdvancePendingRef.current=true;setReadCh(c=>c+1);}:null);
    navigator.mediaSession.setActionHandler('previoustrack',readCh>1?()=>setReadCh(c=>c-1):(readBook>1?()=>{const prev=BIBLE.find(b=>b.n===readBook-1);if(prev){setReadBook(readBook-1);setReadCh(prev.v.length);}}:null));
  },[readBook,readCh]);
  // ── Close topSheet modals when a nav sheet opens or tab changes ──
  useEffect(()=>{if(readMobileSheet)closeModal();},[readMobileSheet]);
  useEffect(()=>{closeModal();},[tab]);
  // ── Wire up audio element events ──
  useEffect(()=>{
    const el=audioElRef.current;
    if(!el)return;
    const onPlay=()=>setAudioPlaying(true);
    const onPause=()=>setAudioPlaying(false);
    const onEnded=()=>{setAudioPlaying(false);if(audioAutoAdvance)handleNextChapterRef.current?.();};
    const onError=()=>{
      if(audioModeRef.current==='speech')return;
      if(!el.src||el.src===window.location.href)return;
      setAudioLoaded(false);setAudioPlaying(false);
      el.removeAttribute('src');
      if(!Capacitor.isNativePlatform()){loadChapterAudioRef.current?.('speech');}
    };
    const onTimeUpdate=()=>{
      if(!audioTimestampsRef.current)return;
      const t=el.currentTime;
      const verses=Object.entries(audioTimestampsRef.current);
      for(let i=0;i<verses.length;i++){
        const [v,ts]=verses[i];
        const nextTs=i<verses.length-1?Number(verses[i+1][1]):Infinity;
        const lowerBound=i===0?0:Number(ts);
        if(t>=lowerBound&&t<nextTs){
          const vNum=Number(v);
          if(currentVerseRef.current!==vNum){
            currentVerseRef.current=vNum;
            setCurrentVerse(vNum);
            if(audioAutoScroll)audioScrollTo(vNum);
          }
          break;
        }
      }
    };
    el.addEventListener('play',onPlay);
    el.addEventListener('pause',onPause);
    el.addEventListener('ended',onEnded);
    el.addEventListener('error',onError);
    el.addEventListener('timeupdate',onTimeUpdate);
    return()=>{
      el.removeEventListener('play',onPlay);
      el.removeEventListener('pause',onPause);
      el.removeEventListener('ended',onEnded);
      el.removeEventListener('error',onError);
      el.removeEventListener('timeupdate',onTimeUpdate);
    };
  },[audioAutoScroll,audioAutoAdvance]);
  // ── Sync rate with audio element ──
  // defaultPlaybackRate as well as playbackRate: the first is what a load
  // restores the second to, so setting only playbackRate lasted until the next
  // chapter and no further — and setting it while nothing was loaded was undone
  // by the load that followed, which is why the change only appeared to take
  // when it was made mid-playback.
  useEffect(()=>{
    audioRateRef.current=audioRate;
    const el=audioElRef.current;
    if(el){el.defaultPlaybackRate=audioRate;el.playbackRate=audioRate;}
  },[audioRate]);
  // ── Sync rate with speech synthesis ──
  // An utterance handed to speak() keeps the rate it was built with; setting
  // .rate on it afterwards does nothing, so the spoken voice had the opposite
  // fault to the recordings — a change took hold on the next chapter but never
  // on the one being read. The remaining verses are queued again instead,
  // picking up at the verse in progress. Debounced, because the slider fires on
  // every step of a drag and each one would otherwise restart the verse.
  const rateRequeue=useRef(null);
  useEffect(()=>{
    if(audioModeRef.current!=='speech'||!audioPlaying)return;
    clearTimeout(rateRequeue.current);
    rateRequeue.current=setTimeout(()=>{
      if(audioModeRef.current!=='speech')return;
      loadChapterAudioRef.current?.(null,currentVerseRef.current);
    },400);
    return()=>clearTimeout(rateRequeue.current);
  },[audioRate]);
  // ── Populate voice list when browser finishes loading voices ──
  useEffect(()=>{
    const onVoicesChanged=()=>setAvailableVoices(TTS.getVoices());
    TTS.addEventListener('voiceschanged',onVoicesChanged);
    // Populate immediately in case voices are already available (Firefox/Safari)
    const v=TTS.getVoices();
    if(v.length)setAvailableVoices(v);
    return()=>TTS.removeEventListener('voiceschanged',onVoicesChanged);
  },[]);
  // ── Restart speech from current verse when voice changes while playing ──
  useEffect(()=>{
    if(audioPlaying&&audioSource==='speech'&&currentVerse!=null){
      seekWebSpeechToVerse(currentVerse);
    }
  },[voicesByVersion[readVid]]);
  // ── Sync audio element currentTime when clicking a verse ──
  useEffect(()=>{
    if(audioTimestampsRef.current&&currentVerse!==null){
      const ts=audioTimestampsRef.current[currentVerse];
      if(ts!==undefined&&audioElRef.current){
        // Only seek if the click came from user, not from timeupdate
        // This is managed in verse click handler below
      }
    }
  },[]);
  // ── Sync speech synthesis pause/resume with audio player ──
  useEffect(()=>{
    if(audioPlaying){
      if(audioSource==='speech'){
        // Speech is managed by loadChapterAudio and play/pause handlers
      }
    }
  },[audioPlaying,audioSource]);
  // ── Sync body background with theme ──
  useEffect(()=>{document.body.style.background=T.bg;},[T.bg]);
  // iOS picks the status bar style from the *device* appearance, not ours, so a
  // light theme on a dark-mode phone drew white text on a cream background and
  // the clock vanished. Style.Light means dark glyphs for a light background.
  useEffect(()=>{
    if(!Capacitor.isNativePlatform())return;
    StatusBar.setStyle({style:dark?Style.Dark:Style.Light}).catch(()=>{});
  },[dark]);
  // iOS can drop the status bar style when the app returns from the background,
  // so re-assert it on resume rather than waiting for the next theme change.
  useEffect(()=>{
    if(!Capacitor.isNativePlatform())return;
    let h;
    CapApp.addListener('appStateChange',({isActive})=>{
      if(isActive)StatusBar.setStyle({style:dark?Style.Dark:Style.Light}).catch(()=>{});
    }).then(x=>{h=x;}).catch(()=>{});
    return()=>{if(h)h.remove();};
  },[dark]);
  // Offline is a first-class state here, so say so rather than letting requests
  // fail quietly and leaving people wondering what is missing.
  const[online,setOnline]=useState(true);
  useEffect(()=>{
    let h,killed=false;
    // networkStatusChange reported going offline but never coming back, so the
    // marker stuck. Re-read the real status from several angles instead of
    // trusting one event: the browser's own online/offline events, every
    // foreground, and a slow poll as the backstop.
    const check=()=>Network.getStatus().then(st=>{if(!killed)setOnline(st.connected);}).catch(()=>{if(!killed)setOnline(true);});
    check();
    Network.addListener('networkStatusChange',st=>{if(!killed)setOnline(st.connected);}).then(x=>{h=x;}).catch(()=>{});
    window.addEventListener('online',check);
    window.addEventListener('offline',check);
    document.addEventListener('visibilitychange',check);
    const poll=setInterval(check,15000);
    return()=>{
      killed=true;
      if(h)h.remove();
      window.removeEventListener('online',check);
      window.removeEventListener('offline',check);
      document.removeEventListener('visibilitychange',check);
      clearInterval(poll);
    };
  },[]);
  useEffect(()=>{
    const measure=()=>{if(navRef.current)setNavH(navRef.current.getBoundingClientRect().height);};
    measure();
    const ro=new RObserver(measure);
    if(navRef.current)ro.observe(navRef.current);
    window.addEventListener('resize',measure);
    return()=>{ro.disconnect();window.removeEventListener('resize',measure);};
  },[ready,installing]);
  // Re-measure nav height after loading completes (navRef is null during loading screen).
  // Double rAF ensures WKWebView has resolved env(safe-area-inset-top) before measuring.
  useEffect(()=>{
    if(!ready||!navRef.current)return;
    setNavH(navRef.current.getBoundingClientRect().height);
    let r2;
    const r1=requestAnimationFrame(()=>{r2=requestAnimationFrame(()=>{if(navRef.current)setNavH(navRef.current.getBoundingClientRect().height);});});
    return()=>{cancelAnimationFrame(r1);if(r2)cancelAnimationFrame(r2);};
  },[ready,installing]);
  // Measure the verse strip too: the plan row stacks on top of it rather than
  // standing down for it, so it needs to know how tall it is.
  useEffect(()=>{
    if(!stripOpen){setVerseStripH(0);return;}
    const measure=()=>{if(verseStripRef.current)setVerseStripH(verseStripRef.current.offsetHeight);};
    measure();
    const ro=new RObserver(measure);
    if(verseStripRef.current)ro.observe(verseStripRef.current);
    return()=>ro.disconnect();
  },[stripOpen]);

  // Measure the plan strip, so the reading can be padded clear of it.
  useEffect(()=>{
    if(!planStrip){setPlanStripH(0);document.documentElement.style.removeProperty('--plan-strip');return;}
    const measure=()=>{if(planStripRef.current){const h=planStripRef.current.offsetHeight;setPlanStripH(h);document.documentElement.style.setProperty('--plan-strip',(h+8)+'px');}};
    measure();
    const ro=new RObserver(measure);
    if(planStripRef.current)ro.observe(planStripRef.current);
    return()=>{ro.disconnect();document.documentElement.style.removeProperty('--plan-strip');};
  },[planStrip]);

  // Measure bottom bar height
  useEffect(()=>{
    const measure=()=>{if(bottomBarRef.current)setBottomBarH(bottomBarRef.current.offsetHeight);};
    measure();
    const ro=new RObserver(measure);
    if(bottomBarRef.current)ro.observe(bottomBarRef.current);
    window.addEventListener('resize',measure);
    return()=>{ro.disconnect();window.removeEventListener('resize',measure);};
  },[ready,installing]);
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
    if(scrollBookUnderBar(readSearchJumpTo.current))readSearchJumpTo.current=null;
  },[readSearchLimit]);

  // ── Load active lexicon data when activeLexiconId changes ──
  useEffect(()=>{
    if(!activeLexiconId){setActiveLexData(null);return;}
    idbGetResourceWithChapters(activeLexiconId).then(res=>{
      if(res)setActiveLexData(res);
      else{setActiveLexiconId(null);try{localStorage.removeItem('scrip:activeLexId');}catch{}}
    }).catch(()=>{});
  },[activeLexiconId]);

  // ── Load active dictionary data when activeDictId changes ──
  useEffect(()=>{
    if(!activeDictId){setActiveDictData(null);return;}
    idbGetResourceWithChapters(activeDictId).then(res=>{
      if(res)setActiveDictData(res);
      else{setActiveDictId(null);try{localStorage.removeItem('scrip:activeDictId');}catch{}}
    }).catch(()=>{});
  },[activeDictId]);

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
    bootMark('auth-start');
    Auth.getSession().then(s=>{bootMark('auth',s?.user?'signed in':'no session');setUser(s?.user||null);setAuthChecked(true);});
    // Coming back after a long spell in the background is the moment the token
    // is most likely to be stale. The 401 retry would cover it either way; this
    // just means the first thing the reader does is not the request that has to
    // discover it.
    const wake=()=>{if(document.visibilityState==='visible')Auth.getSession();};
    document.addEventListener('visibilitychange',wake);
    const off=Auth.onAuthChange(u=>{setUser(u||null);if(!u){setData(null);setReady(false);setProjectId(null);}});
    return()=>{document.removeEventListener('visibilitychange',wake);off&&off();};
  },[]);

  // Bookmarks, highlights, recent passages and categories are the reader's own
  // and need nothing from the project, so they load as soon as the reader is
  // known -- and a request that fails is tried again. They used to wait for the
  // project, load once, and be skipped outright if the project failed: the app
  // then opened with every list empty, looking as if all of it had been deleted.
  const listsFor=useRef(null);
  function loadUserLists(uid){
    listsFor.current=uid;
    const waits=[2000,5000,12000,30000];
    const load=(fn,set)=>{
      let n=0;
      const go=()=>fn(uid).then(v=>{if(listsFor.current===uid)set(v);}).catch(()=>{if(listsFor.current===uid&&n<waits.length)setTimeout(go,waits[n++]);});
      go();
    };
    load(dbLoadBookmarks,setBookmarks);load(dbLoadHighlights,setHighlights);
    load(dbLoadRecents,setRecents);load(dbLoadCategories,setBmCategories);
  }
  // ── Load project on auth ──
  useEffect(()=>{
    if(!user){listsFor.current=null;return;}
    if(user.guest){
      const pd={versions:PUBLIC_VERSIONS,sections:[],entries:[]};
      setProjectId('guest-local');
      setData(pd);
      setReadVid(PUBLIC_VERSIONS.find(v=>v.isRef)?.id||PUBLIC_VERSIONS[0]?.id||'kjv');
      setParallelVids(PUBLIC_VERSIONS.map(v=>v.id));
      setBookmarks([]);setRecents([]);setBmCategories([]);setHighlights([]);
      setLoadMsg('');setReady(true);
      idbGetAllResources().then(all=>{
        setResources(all.filter(r=>r.category==='other'||!r.category));
        setUserMaps(all.filter(r=>r.category==='maps'));
        setUserCharts(all.filter(r=>r.category==='charts'));
        setUserLexicons(all.filter(r=>r.category==='lexicon').map(r=>({id:r.id,title:r.title,ext:r.ext,importedAt:r.importedAt,kind:r.kind,entryCount:r.entryCount})));
        setUserDicts(all.filter(r=>r.category==='dict').map(r=>({id:r.id,title:r.title,ext:r.ext,importedAt:r.importedAt,kind:r.kind,entryCount:r.entryCount})));
      }).catch(()=>{});
      return;
    }
    listsFor.current=null;
    (async()=>{
      setReady(false);setLoadMsg('Loading project…');
      loadUserLists(user.id);
      // A slow first request is not a missing project: try a few times before
      // opening without it.
      let proj=null;
      bootMark('project-start');
      for(const wait of [0,1500,4000]){
        if(wait)await new Promise(r=>setTimeout(r,wait));
        try{proj=await dbLoadOrCreateProject(user.id);break;}catch(e){proj=null;bootMark('project-retry',e&&e.message);}
      }
      bootMark(proj?'project':'project-failed');
      if(!proj){setData({versions:PUBLIC_VERSIONS,sections:[],entries:[]});setReadVid(PUBLIC_VERSIONS.find(v=>v.isRef)?.id||'kjv');setParallelVids(PUBLIC_VERSIONS.map(v=>v.id));setLoadMsg('');setReady(true);return;}
      setProjectId(proj.id);
      setLoadMsg('Loading study data…');
      let pd;
      try{pd=await dbLoadProject(proj.id);}catch(e){setData({versions:PUBLIC_VERSIONS,sections:[],entries:[]});setReadVid(PUBLIC_VERSIONS.find(v=>v.isRef)?.id||'kjv');setParallelVids(PUBLIC_VERSIONS.map(v=>v.id));setLoadMsg('');setReady(true);return;}
      if(!pd.versions.length){
        setLoadMsg('Setting up versions…');
        await dbSaveVersions(proj.id,PUBLIC_VERSIONS);
        pd.versions=PUBLIC_VERSIONS;
      } else {
        // Silently repair duplicates in project_versions (can occur from race conditions on first load)
        const pvRaw=await sbFrom('project_versions',getToken()).then(t=>t.select('version_id',{project_id:proj.id}));
        const pvRows=pvRaw.data||[];
        if(pvRows.length>pd.versions.length){
          await dbSaveVersions(proj.id,pd.versions);
        }
      }
      // Seed default sections + sample entries for brand-new users
      if(pd.sections.length===0&&pd.entries.length===0){
        setLoadMsg('Preparing starter content…');
        const s1id=await dbSaveSection({title:'Spanish / Espanol',description:'Use this section to make notes on Spanish Bible versions.',position:0,_isNew:true},proj.id);
        const s2id=await dbSaveSection({title:'English',description:'Use this section to compare English Bible versions.',position:1,_isNew:true},proj.id);
        await dbSaveSection({title:'Albanian / Shqip',description:'Use this section to make notes on Albanian Bible versions.',position:2,_isNew:true},proj.id);
        const refVid=pd.versions.find(v=>v.isRef)?.id||pd.versions[0]?.id||'kjv';
        const g11texts=await dbAutoFill(1,1,1,pd.versions.map(v=>v.id));
        const G11_FALLBACK={kjv:'In the beginning God created the heaven and the earth.',rvg:'En el principio creó Dios el cielo y la tierra.',p1602:'EN el principio creó Dios el cielo y la tierra.'};
        const vdata1={};for(const v of pd.versions){const txt=g11texts[v.id]||G11_FALLBACK[v.id]||'';if(txt)vdata1[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
        const e1={id:genId(),sectionId:s1id,reference:'Genesis 1:1',issueLabel:'',issueType:'manuscript',notes:'Some versions translate Genesis 1:1 "heaven" as plural. This is not accurate as God had only created one heaven at this point.',greekHebrew:'',sourceRefs:'',versions:vdata1,_isNew:true};
        await dbSaveEntry(e1,proj.id);
        const pd2=await dbLoadProject(proj.id);
        setData(pd2);
      }else{
        setData(pd);
      }
      setReadVid(pd.versions.find(v=>v.isRef)?.id||pd.versions[0]?.id||'kjv');
      setParallelVids(pd.versions.map(v=>v.id));
      setLoadMsg('');setReady(true);
      idbGetAllResources().then(all=>{
        setResources(all.filter(r=>r.category==='other'||!r.category));
        setUserMaps(all.filter(r=>r.category==='maps'));
        setUserCharts(all.filter(r=>r.category==='charts'));
        setUserLexicons(all.filter(r=>r.category==='lexicon').map(r=>({id:r.id,title:r.title,ext:r.ext,importedAt:r.importedAt,kind:r.kind,entryCount:r.entryCount})));
        setUserDicts(all.filter(r=>r.category==='dict').map(r=>({id:r.id,title:r.title,ext:r.ext,importedAt:r.importedAt,kind:r.kind,entryCount:r.entryCount})));
      }).catch(()=>{});
    })();
  },[user]);

  // ── Install the datasets shipped inside the app (once per device) ──
  // Runs before anything needs them, so a first launch is offline-ready without
  // the user ever visiting the download screen.
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        await installBundledDatasets((done,total)=>{if(!cancelled)setBundledInstall({done,total});});
      }catch(e){console.warn('Bundled data install failed:',e);}
      if(!cancelled)setBundledInstall(null);
      // Re-read now that the install has written its flags, or the Offline Data
      // panel keeps showing everything as not downloaded.
      if(!cancelled)refreshDownloadStates().catch(()=>{});
    })();
    return()=>{cancelled=true;};
  },[]);

  // The Treasury is not needed to open the app. It installs once the app is up
  // and the reader's own data has gone first, with no install screen; it used to
  // sit behind that screen, where 14 MB of writes on a full database held the
  // app shut and crowded out the requests for the reader's bookmarks.
  const[bgInstalled,setBgInstalled]=useState(0);
  const bgInstall=useRef(false);
  useEffect(()=>{
    if(!ready||installing||bgInstall.current)return;
    const t=setTimeout(()=>{
      if(bgInstall.current)return;
      bgInstall.current=true;
      installBundledDatasets(null,{background:true})
        .then(did=>{if(did)setBgInstalled(n=>n+1);})
        .catch(e=>console.warn('Background install failed:',e));
    },4000);
    return()=>clearTimeout(t);
  },[ready,installing]);

  // ── Install bundled default resources (once per device, regardless of login) ──
  useEffect(()=>{
    const FOXES_ID='bundled-foxes-book-of-martyrs';
    (async()=>{
      const already=await idbGetMeta('bundled:foxes').catch(()=>null);
      if(already)return;
      try{
        const resp=await fetch(`${BUNDLED_BASE}defaults/foxes_book_of_martyrs.refi`);
        if(!resp.ok)return;
        const buf=await resp.arrayBuffer();
        const file=new File([buf],'foxes_book_of_martyrs.refi',{type:'application/octet-stream'});
        const res=await _importSqliteResource(file,FOXES_ID,"Foxe's Book of Martyrs",'refi','other');
        await idbPutMeta('bundled:foxes',true);
        setResources(prev=>{
          if(prev.find(r=>r.id===FOXES_ID))return prev;
          return[...prev,{id:res.id,title:res.title,ext:res.ext,importedAt:res.importedAt,kind:res.kind,entryCount:res.entryCount}];
        });
      }catch(e){console.warn("Bundled Foxe's install failed:",e);}
    })();
  },[]);

  // ── Load reading chapter ──
  useEffect(()=>{
    if(!readVid||!ready||installing)return;
    let cancelled=false;
    // If only the version changed (same book+chapter), preserve any highlighted verses
    const prev=prevReadStateRef.current;
    if(prev.vid&&prev.vid!==readVid&&prev.book===readBook&&prev.ch===readCh&&readSelVerses.size>0){
      readPendingSelVerses.current=new Set(readSelVerses);
    }
    prevReadStateRef.current={vid:readVid,book:readBook,ch:readCh};
    setReadSelVerses(new Set());
    autoSel.current=false;
    landSeq.current++;
    // Close strip immediately so it doesn't flash empty while new chapter loads
    if(!readPendingSelVerses.current)setStripOpen(false);
    dbGetChapter(readVid,readBook,readCh).then(rows=>{
      if(!cancelled){
        setReadVerses(rows);
        if(!bootChapter.current){bootChapter.current=true;bootMark('chapter',`${readVid} ${readBook}:${readCh} ${rows.length}v`);}
        // Landing on a verse selects it, and a selected verse shows its strip.
        // Anything that arrives here has been asked for by name — a search
        // result, a typed reference, a cross-reference, a bookmark — so the
        // things you would want to do with it are the point of going. A verse
        // lit with no strip now means one thing only: the audio is reading it,
        // which the strip's own gate already excludes.
        if(readScrollToVerse.current){const tv=readScrollToVerse.current;readScrollToVerse.current=null;const quiet=landSilent.current;landSilent.current=false;landOnVerse(tv,quiet);}
        else{readRef.current?.scrollTo({top:0,behavior:'instant'});}
        if(readPendingSelVerses.current){const vs=readPendingSelVerses.current;readPendingSelVerses.current=null;setTimeout(()=>{const firstV=Math.min(...vs);const el=document.getElementById(`rv-${firstV}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(vs);setStripOpen(true);},80);}
      }
      if(user&&!user.guest&&!cancelled){
        // Optimistic local update — works offline too
        const now=new Date().toISOString();
        setRecents(prev=>{
          const existing=prev.find(r=>r.version_id===readVid&&r.book_num===readBook&&r.chapter===readCh);
          const entry={id:existing?.id||`local-${readVid}-${readBook}-${readCh}`,user_id:user.id,version_id:readVid,book_num:readBook,chapter:readCh,visited_at:now};
          return[entry,...prev.filter(r=>!(r.version_id===readVid&&r.book_num===readBook&&r.chapter===readCh))].slice(0,20);
        });
        // Persist to Supabase and refresh with real DB state (online only)
        dbRecordRecent(user.id,readVid,readBook,readCh).then(()=>{dbLoadRecents(user.id).then(setRecents).catch(()=>{});}).catch(()=>{});
      }
    }).catch(()=>{
      if(!cancelled)setReadVerses([]);
    });
    return()=>{cancelled=true;};
  },[readVid,readBook,readCh,ready,installing]);

  // ── Persist Strong's mode ──
  useEffect(()=>{localStorage.setItem('scrip:strongsMode',JSON.stringify(strongsMode));},[strongsMode]);

  // ── Load Strong's data for current chapter ──
  useEffect(()=>{
    if(!strongsMode||!ready||installing||readVid!=='kjv'){setStrongsData(d=>Object.keys(d).length?{}:d);return;}
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
  },[strongsMode,readBook,readCh,ready,readVid,installing]);

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
    // The definition is in IndexedDB once Strong's is downloaded, but occurrences
    // are server-only. Settle the two independently — with Promise.all a failed
    // network call rejected the pair, threw away a definition we already had
    // locally, and left the caller's spinner running forever.
    const[e,v]=await Promise.allSettled([dbGetStrongsEntry(strongsNum),dbGetStrongsVerses(strongsNum)]);
    const entry=e.status==='fulfilled'?e.value:null;
    const versesOffline=v.status!=='fulfilled';
    const res={entry,verses:versesOffline?[]:v.value,versesOffline};
    // Never cache a half result, or a lookup made offline would keep returning
    // empty occurrences once the connection is back.
    if(!versesOffline)strongsCache.current[strongsNum]=res;
    return res;
  }
  async function handleStrongsWordTap(strongsNum,wordText){
    setStrongsExpandedWords(new Set());
    const cached=strongsCache.current[strongsNum];
    if(cached){
      setStrongsPopup({strongs_number:strongsNum,word_text:wordText,entry:cached.entry,verses:cached.verses,versesLoading:false,history:[]});
      return;
    }
    setStrongsPopup({strongs_number:strongsNum,word_text:wordText,entry:null,verses:null,versesLoading:true,history:[]});
    const{entry,verses,versesOffline}=await fetchStrongsData(strongsNum);
    setStrongsPopup(prev=>prev&&prev.strongs_number===strongsNum?{...prev,entry,verses,versesOffline,versesLoading:false}:prev);
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
      const{entry,verses,versesOffline}=await fetchStrongsData(strongsNum);
      setStrongsPopup(prev=>prev&&prev.strongs_number===strongsNum?{...prev,entry,verses,versesOffline,versesLoading:false}:prev);
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
    const bk=bookName(BIBLE[bn-1],versionLang(readVid));
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
    Promise.allSettled(parallelVids.map(vid=>dbGetChapter(vid,parallelBk,parallelCh))).then(results=>{
      if(!cancelled){
        const map={};parallelVids.forEach((vid,i)=>{map[vid]=results[i].status==='fulfilled'?results[i].value||[]:[];});
        setParallelChapters(map);setParallelLoading(false);
      }
    });
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
    if(readSearchRes&&readSearchResultsOpen&&readSearchLimit<readSearchRes.length&&el.scrollHeight-el.scrollTop-el.clientHeight<500&&!loadMorePendingRef.current){
      loadMorePendingRef.current=true;
      setReadSearchLimit(n=>{loadMorePendingRef.current=false;return n+50;});
    }
    trackSearchBook(el);
  }
  // Which book the reader has scrolled to, for the bar above the results. The
  // anchors are the ones the wheel jumps to, so this needs nothing
  // added to the rows. Measured once a frame — getBoundingClientRect on every
  // scroll event would thrash layout.
  function trackSearchBook(el){
    // A glide is flying the list past on purpose; the label lands with it.
    if(!el||el._glide)return;
    // An id rather than a flag: a frame that never arrives — the app put to sleep
    // mid-scroll, say — used to leave the flag raised and the label frozen on
    // whatever book it last saw, for the rest of the session.
    if(searchBookRaf.current)cancelAnimationFrame(searchBookRaf.current);
    searchBookRaf.current=requestAnimationFrame(()=>{
      searchBookRaf.current=0;
      const heads=el.querySelectorAll('[id^="srch-bk-"]');
      if(!heads.length){setSearchTopBook(null);return;}
      // The line is the top of what the reader can actually see, not the top of
      // the scroll box — the box runs up behind the nav and the bar, and its own
      // padding is what clears them. Measuring from the box meant a jump landed
      // the book below the line and the label kept naming the one before it.
      const line=el.getBoundingClientRect().top+(parseFloat(getComputedStyle(el).paddingTop)||0)+24;
      let cur=Number(heads[0].id.slice(8));
      for(const h of heads){
        if(h.getBoundingClientRect().top<=line)cur=Number(h.id.slice(8));
        else break;
      }
      setSearchTopBook(p=>p===cur?p:cur);
    });
  }

  // ── Keep scroll handler ref fresh every render ──
  scrollHandlerRef.current=(el)=>{
    onSearchScroll(el);
    if(tab==='read')handleReadScroll({target:el});
    // Chapter line pin: trigger when line enters the safe-area slab
    if(chLineRef.current){
      if(!safeAreaTopRef.current)safeAreaTopRef.current=measureSafeAreaTop();
      const rect=chLineRef.current.getBoundingClientRect();
      setChLineAbove(rect.bottom<=safeAreaTopRef.current);
    }
  };

  // ── Reading helpers ──
  const readBk=BIBLE.find(b=>b.n===readBook);const readTotalCh=readBk?.v?.length||1;
  const readVerLabel=data?.versions.find(v=>v.id===readVid)?.label||readVid?.toUpperCase()||'';
  function readPrevCh(){if(readCh>1)setReadCh(c=>c-1);else if(readBook>1){const nb=readBook-1;setReadBook(nb);setReadCh(BIBLE.find(b=>b.n===nb)?.v?.length||1);}}
  function readNextCh(){if(readCh<readTotalCh)setReadCh(c=>c+1);else if(readBook<66){setReadBook(b=>b+1);setReadCh(1);}}
  // ── Commentary helpers ──
  function cmStep(d){
    setCmFocus(null);
    if(d<0){if(cmCh>1)setCmCh(c=>c-1);else if(cmBook>1){const nb=cmBook-1;setCmBook(nb);setCmCh(BIBLE[nb-1]?.v?.length||1);}}
    else{const tot=BIBLE[cmBook-1]?.v?.length||1;if(cmCh<tot)setCmCh(c=>c+1);else if(cmBook<66){setCmBook(b=>b+1);setCmCh(1);}}
  }
  // Followed out of the commentary, a reference lands the way a highlight does:
  // the verse lit, and the verse bar left shut.
  function cmGo(r){
    if(r.b===readBook&&r.c===readCh){readScrollToVerse.current=null;landOnVerse(r.v,true);}
    else{readScrollToVerse.current=r.v;landSilent.current=true;setReadBook(r.b);setReadCh(r.c);}
    setTab('read');
  }
  // Auto full screen, by the same rules as Read: down past the threshold hides
  // the bars, back up (or to the top) brings them back.
  const cmLastY=useRef(0),cmDelta=useRef(0);
  const[cmLineAbove,setCmLineAbove]=useState(false);
  useEffect(()=>{setCmLineAbove(false);},[cmBook,cmCh,cmId]);
  function cmScroll(sy,own,lineBottom){
    if(lineBottom!=null){
      if(!safeAreaTopRef.current)safeAreaTopRef.current=measureSafeAreaTop();
      setCmLineAbove(lineBottom<=safeAreaTopRef.current);
    }
    const dy=sy-cmLastY.current;cmLastY.current=sy;
    if(own){cmDelta.current=0;return;}
    if(sy<=5){if(readFullScreen.current)exitFullScreen();cmDelta.current=0;return;}
    if(Math.sign(dy)!==Math.sign(cmDelta.current))cmDelta.current=0;
    cmDelta.current+=dy;
    if(cmDelta.current>fsScrollThreshold&&!readFullScreen.current){if(readAutoFullscreen)enterFullScreen();cmDelta.current=0;}
    else if(cmDelta.current<-fsScrollThreshold&&readFullScreen.current){exitFullScreen();cmDelta.current=0;}
  }
  function cmOpenNav(){setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);openReadSheet('nav');}
  async function cmImport(f){const meta=await importCommentaryFile(f);setCmImports(l=>[meta,...l]);setCmId(meta.id);return meta;}
  async function cmDelete(id){
    await idbDeleteCommentary(id).catch(()=>{});
    await idbDeleteCommentaryMeta(id).catch(()=>{});
    setCmImports(l=>l.filter(c=>c.id!==id));
    if(cmId===id)setCmId(TSKE_ID);
  }
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
  // A bookmark or a recent can outlive the version it was made in; it opens in
  // the reference version rather than on an empty page.
  const usableVid=vid=>(data?.versions||[]).some(v=>v.id===vid)?vid:((data?.versions||[]).find(v=>v.isRef)?.id||data?.versions?.[0]?.id||vid);
  function openFromBookmark(bm){
    const vid=usableVid(bm.version_id);
    setModal(null);
    setReadBook(bm.book_num);
    setReadCh(bm.chapter);
    setReadVid(vid);
    setTab('read');
    // Parse verse selection from label (e.g. "Genesis 1:3-5, 7") or fall back to single verse field
    const verses=new Set();
    try{
      // Try to extract range string after "BookName Ch:" from label
      const labelMatch=(bm.label||'').match(/\s\d+:([\d,\s-]+)$/);
      const rangeStr=labelMatch?labelMatch[1]:(bm.verse?String(bm.verse):'');
      if(rangeStr){
        for(const part of rangeStr.split(',')){
          const p=part.trim();
          const rangeM=p.match(/^(\d+)-(\d+)$/);
          if(rangeM){for(let v=parseInt(rangeM[1]);v<=parseInt(rangeM[2]);v++)verses.add(v);}
          else if(/^\d+$/.test(p))verses.add(parseInt(p));
        }
      }
    }catch{}
    if(verses.size>0){
      // If already on this book/chapter/version, the chapter effect won't re-fire — apply immediately
      if(vid===readVid&&bm.book_num===readBook&&bm.chapter===readCh){
        setTimeout(()=>{
          const firstV=Math.min(...verses);
          const el=document.getElementById(`rv-${firstV}`);
          if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
          setReadSelVerses(verses);
          setStripOpen(true);
        },80);
      }else{
        readPendingSelVerses.current=verses;
      }
    }
  }
  function openFromRecent(r){setModal(null);setReadBook(r.book_num);setReadCh(r.chapter);setReadVid(usableVid(r.version_id));setTab('read');}
  // Colour every selected verse, or clear them. The page changes at once and
  // the write follows; a write that fails puts the previous colours back.
  async function applyHighlight(color){
    const verses=[...readSelVerses].sort((a,b)=>a-b);
    if(!verses.length||!user)return;
    const vid=readVid,b=readBook,c=readCh,prev=highlights;
    const here=h=>h.version_id===vid&&h.book_num===b&&h.chapter===c&&verses.includes(h.verse);
    const next=prev.filter(h=>!here(h));
    if(color){const now=new Date().toISOString();for(const v of verses){const old=prev.find(h=>here(h)&&h.verse===v);next.push({version_id:vid,book_num:b,chapter:c,verse:v,color,created_at:old?.created_at||now});}}
    setHighlights(next);dismissStrip();
    if(user.guest)return;
    try{if(color)await dbSetHighlights(user.id,vid,b,c,verses,color);else await dbRemoveHighlights(user.id,vid,b,c,verses);}
    catch(err){console.error('highlight:',err);setHighlights(prev);window.alert("Couldn't save that highlight \u2014 check your connection and try again.");}
  }
  // Lands on the verse in the version it was highlighted in, quietly: the
  // verse is lit and the band shows, without opening the verse bar over it.
  function openFromHighlight(h){
    const vid=usableVid(h.version_id);
    setModal(null);
    if(vid===readVid&&h.book_num===readBook&&h.chapter===readCh){readScrollToVerse.current=null;landOnVerse(h.verse,true);}
    else{readScrollToVerse.current=h.verse;landSilent.current=true;setReadVid(vid);setReadBook(h.book_num);setReadCh(h.chapter);}
    setTab('read');
  }

  // `live` marks a search the reader did not ask for — one the debounce below
  // fired while they were still typing. Those skip everything that only makes
  // sense for a deliberate search, and stop after a single page: an exhaustive
  // search of a common word is dozens of round-trips, which is fine once but
  // ruinous per keystroke.
  async function doReadSearch(overrideQ,overrideOpts,live=false){
    const query=(overrideQ!==undefined?overrideQ:readSearchQ).trim();
    if(!query)return;
    // Nothing stopped two searches overlapping, and whichever finished last won
    // — so a slow search for an early prefix could land on top of the results
    // for what was actually typed. Every write below is now gated on this still
    // being the most recent search.
    const seq=++searchSeqRef.current;
    const current=()=>seq===searchSeqRef.current;
    if(!live){searchTypedRef.current=false;flashSearch();}
    if(overrideQ!==undefined)setReadSearchQ(overrideQ);
    setReadSearching(true);
    if(!live){setReadSearchRes(null);setReadSearchResultsOpen(false);setReadSearchPopover(false);}
    setReadSearchLimit(50);
    if(!live){
      const newRecent=[query,...recentSearches.filter(r=>r!==query)].slice(0,10);
      setRecentSearches(newRecent);
      try{localStorage.setItem('scrip_recent_searches',JSON.stringify(newRecent));}catch{}
    }
    try{
      const opts=overrideOpts||searchOpts;
      const token=getToken();
      const words=query.split(/\s+/).filter(Boolean);
      const cs=opts.caseSensitive;
      const ww=opts.partial===false;
      const bookMin=opts.scope==='nt'?40:1;
      const bookMax=opts.scope==='ot'?39:66;
      const PAGE=900;
      let capped=false; // set only if a live search stopped on a full page
      const baseParams=(q)=>({p_version_id:readVid,p_query:q,p_limit:PAGE,p_book_min:bookMin,p_book_max:bookMax,p_case_sensitive:cs,p_whole_word:ww});
      // Scanning the downloaded copy, held in memory so a run of keystrokes does
      // not pull 31,000 rows out of IndexedDB apiece.
      async function localRows(){
        if(localVersesRef.current&&localVersesRef.current.key===`${readVid}|${bookMin}|${bookMax}`)return localVersesRef.current.rows;
        const rows=await idbSearchLocal(readVid,bookMin,bookMax);
        localVersesRef.current={key:`${readVid}|${bookMin}|${bookMax}`,rows};
        return rows;
      }
      function scanLocal(rows,q){
        const ql=q.toLowerCase();
        return rows.filter(r=>(r.text||'').toLowerCase().includes(ql));
      }
      async function fetchAll(q){
        // Local first when the version is on the device — the same order every
        // other reader in this file uses, and it makes a downloaded version
        // search without touching the network at all.
        try{
          if(await idbIsDownloaded(readVid))return scanLocal(await localRows(),q);
        }catch{}
        try{
          let all=[];let offset=0;
          while(true){
            const{data:res,error}=await sbRpc('search_verses',{...baseParams(q),p_offset:offset},token);
            // An error status does not throw, so this used to break out and
            // report no verses found with a usable local copy sitting right
            // there. Only a genuine absence of rows ends the loop quietly.
            if(error)throw error;
            if(!Array.isArray(res)||res.length===0)break;
            all=all.concat(res);
            if(res.length<PAGE)break;
            // Only reachable on a full page, since a short one breaks above —
            // so this is the one case where there really may be more.
            if(live){capped=true;break;}
            offset+=res.length;
          }
          return all;
        }catch{
          return scanLocal(await localRows(),q);
        }
      }
      // The phrase honours Partial Match as the words do: it used to match
      // anywhere, so with Partial Match off "rod" still listed every Herod.
      // Matched against the bare verse, as the highlight and the count are.
      const phraseRx=searchRx(query,opts,false),wordRx=words.map(w=>searchRx(w,opts,false));
      function matches(text){
        const t=searchPlain(text);
        if(opts.mode==='phrase')return phraseRx.test(t);
        if(opts.mode==='all')return wordRx.every(rx=>rx.test(t));
        return wordRx.some(rx=>rx.test(t));
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
      if(!current())return;
      results=results.filter(r=>matches(r.text||''));
      results.sort((a,b)=>a.book_num-b.book_num||a.chapter-b.chapter||a.verse-b.verse);
      // Count the occurrences, while typing as well as on a committed search.
      // This was skipped live on the assumption it was costly; measured against
      // the KJV it is 6ms for "the" — 24,095 verses and 63,944 occurrences —
      // because the regexes are built once per word here rather than once per
      // verse per word, as they were.
      //
      // A capped set is the exception: its count would be of one page, not of
      // the Bible, and a wrong number is worse than none.
      if(capped){
        setReadSearchOccurrences(null);
      } else {
        const occWords=opts.mode==='phrase'?[query]:words;
        const occRx=occWords.map(w=>searchRx(w,opts));
        let occ=0;
        results.forEach(r=>{
          const txt=searchPlain(r.text);
          for(const rx of occRx){const m=txt.match(rx);if(m)occ+=m.length;}
        });
        setReadSearchOccurrences(occ);
      }
      if(!current())return;
      setReadSearchCapped(capped);
      setSearchTopBook(results.length?results[0].book_num:null);
      setReadSearchRes(results);
      setReadSearchResQ(query);
      setReadSearchResultsOpen(true);
      if(!live){
        // The field stays. Taking it away on Enter made the full results look
        // like a second screen, when they are the same list the live search was
        // already showing — only complete. The filters stay too: they are pinned
        // by the reader, not by the search.
        setTimeout(()=>{if(readRef.current)readRef.current.scrollTop=0;},30);
        closeReadSheet();
      }
    }catch(err){
      if(!current())return;
      setReadSearchRes([]);
      setReadSearchResQ(query);
      setReadSearchResultsOpen(true);
      // An error takes the results away, not the field: closing it left no way
      // to try the search again without reopening search from the nav bar.
      if(!live)closeReadSheet();
    }finally{
      if(current())setReadSearching(false);
    }
  }
  // Leaving search behind retires whatever search is still in flight. A reply
  // that landed afterwards reopened the results over whatever the reader had
  // moved on to — and with the field gone, nothing on screen could close them.
  function abandonSearch(){++searchSeqRef.current;setReadSearching(false);}
  // Search is a place you leave, not a thing you submit: the top bar's button
  // opens it and closes it, and nothing else. Closing runs as an animation —
  // the bar lifts back behind the nav, the page under it fades — and the
  // chapter returns once it has gone.
  const searchIsOpen=searchFieldOpen||readSearchResultsOpen;
  function closeSearch(){
    if(!searchIsOpen)return;
    if(searchCloseTimer.current)clearTimeout(searchCloseTimer.current);
    if(searchInputRef.current)searchInputRef.current.blur();
    setBookWheelOpen(false);
    setSearchClosing(true);
    searchCloseTimer.current=setTimeout(()=>{
      searchCloseTimer.current=null;
      setSearchClosing(false);
      setSearchFieldOpen(false);
      setReadSearchResultsOpen(false);
      abandonSearch();
    },200);
  }
  // Reopening mid-close retires the teardown, or it would land on the search
  // that was just opened — the same trap the sheets had.
  function cancelSearchClose(){if(searchCloseTimer.current){clearTimeout(searchCloseTimer.current);searchCloseTimer.current=null;}setSearchClosing(false);}
  function openSearch(){
    cancelSearchClose();
    clearAutoSel();
    setBookWheelOpen(false);
    if(readMobileSheet)closeReadSheet();
    closeModal();
    // Search takes the screen, and the Strong's panel was staying over it:
    // every other thing that owns the screen gets stood down here, and this
    // one was simply missed.
    if(strongsPopup)closeStrongsPopup();
    if(readFullScreen.current)exitFullScreen();
    if(tab!=='read')setTab('read');
    if(readSearchRes&&!readSearchResultsOpen&&tab==='read'){
      if(readRef.current)readViewScrollRef.current=readRef.current.scrollTop;
      setReadSearchResultsOpen(true);
      setTimeout(()=>{if(readRef.current)readRef.current.scrollTop=searchResultScrollRef.current;},30);
    }
    setSearchFieldOpen(true);
    // No focus, so no keyboard. Opening search is going somewhere, not starting
    // to type, and half the time it is opened to read results already standing —
    // where the keyboard covered them and had to be dismissed first. Tapping the
    // field, or the magnifier in the bar, is what asks for the keyboard.
  }
  // The bar is the whole search control: it shows while the field is open, and
  // stays while results stand so the reader can see what produced them.
  // A sheet on its way out is already gone as far as the bar is concerned. It
  // used to wait out the 260ms close animation, so tapping search from the book
  // picker left the field, chevron and magnifier missing for a quarter second
  // while the recents and filters below them were already there. Tapping again
  // in that gap reached the bar's submit path instead of opening anything.
  const searchBarOn=tab==='read'&&!(readMobileSheet&&!readSheetClosing)&&!modal&&(searchFieldOpen||!!(readSearchRes&&readSearchResultsOpen));
  // Below three characters there is nothing to search for, so the space under
  // the bar offers recent searches instead.
  const searchShowRecents=searchFieldOpen&&readSearchQ.trim().length<3;
  const searchOptsDirty=Object.keys(SEARCH_DEFAULTS).some(k=>searchOpts[k]!==SEARCH_DEFAULTS[k]);
  // The field, both bar buttons and the filter buttons share one pair of faces:
  // barely tinted while they wait, gold with a soft glow while they are the
  // thing being used. Every colour is read from the theme, so a custom palette
  // lights them in its own gold.
  const CTRL=34; // the bar's row height: the field and the two square buttons
  // Waiting is grey, not gold — the muted body tone, the same one the wheel
  // gives the books either side of its selection. T.gM before it could not be
  // read over glass, and the accent that replaced it could: solid gold on every
  // button made the whole bar look chosen, with nothing left for the one that
  // actually was. Grey reads at arm's length and leaves the gold to mean one
  // thing. The outlines go with it, both of them a good way back from solid:
  // enough to draw the box, not enough to be the first thing seen.
  const ctrlRest={background:`${T.g}0d`,border:`1px solid ${T.gD}99`,boxShadow:'none',color:T.mut};
  const ctrlOn={background:T.gF,border:`1px solid ${T.g}66`,boxShadow:`0 0 0 2px ${T.g}14`,color:T.gT};
  // Anything that stays lit — a chosen scope or mode, the open filter menu, a
  // field holding a query — is a wash of the accent rather than a fill: the
  // same 15% the red pair below has always used, so the two lit states are the
  // same material in two colours. It was T.gF at 72%, a dark fill three
  // quarters of the way to opaque, which next to Case Sensitive read as a
  // different kind of thing altogether. Solid is kept for the one control
  // actually being used: the field under the cursor.
  const ctrlOnSoft={...ctrlOn,background:`${T.g}26`};
  // The play button's face, which is the one that already sits right over the
  // text: the plain dark glass and the faint edge, not the filters' gold wash
  // and 99 border. Those belong on an opaque bar. Lit means the text turns
  // gold and the edge firms up slightly -- the face itself never changes.
  const floatFace={background:'var(--ac-glass-bg)',border:`1px solid ${T.gD}55`,
    backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',boxShadow:'0 4px 14px rgba(0,0,0,0.22)',borderRadius:6};
  const floatOn={...floatFace};
  // Halfway between mut and dim. These labels want to sit below body copy but
  // still read as text you can tap, and neither token on its own does that:
  // mut is a shade loud against the play button, dim is too faint to read.
  // Derived rather than fixed so it follows whatever accent is set.
  const floatText=(()=>{
    const ok=h=>typeof h==='string'&&/^#[0-9a-f]{6}$/i.test(h);
    if(!ok(T.mut)||!ok(T.dim))return T.mut;
    const ch=(h,i)=>parseInt(h.slice(1+i*2,3+i*2),16);
    const mid=i=>Math.round((ch(T.mut,i)+ch(T.dim,i))/2).toString(16).padStart(2,'0');
    return '#'+mid(0)+mid(1)+mid(2);
  })();
  // Case Sensitive and Partial Match light red rather than gold: that colour is
  // warning you they are cutting the result, not decorating the button.
  const ctrlOnRed={background:'rgba(198,40,40,0.15)',border:'1px solid #c62828',boxShadow:'0 0 0 2px rgba(198,40,40,0.2)',color:'#ef5350'};
  const setOpt=(k,v)=>{const o={...searchOpts,[k]:v};setSearchOpts(o);if(readSearchQ.trim().length>=3)doReadSearch(undefined,o,true);};
  const optBtn=(active,label,onClick,red)=>(
    <button key={label} type="button" onClick={onClick}
      style={{flex:1,...(active?(red?ctrlOnRed:ctrlOnSoft):ctrlRest),borderRadius:6,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'background .12s,border-color .12s,color .12s,box-shadow .12s',whiteSpace:'nowrap'}}>
      {label}
    </button>
  );
  const searchFilterRows=()=>(<>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.14em',color:T.mut,textTransform:'uppercase',fontWeight:600,width:38,flexShrink:0}}>Scope</div>
      {[['all','All'],['ot','OT'],['nt','NT']].map(([v,l])=>optBtn(searchOpts.scope===v,l,()=>setOpt('scope',v)))}
    </div>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.14em',color:T.mut,textTransform:'uppercase',fontWeight:600,width:38,flexShrink:0}}>Mode</div>
      {[['all','All Words'],['phrase','Phrase'],['any','Any Word']].map(([v,l])=>optBtn(searchOpts.mode===v,l,()=>setOpt('mode',v)))}
    </div>
    <div style={{display:'flex',gap:4,alignItems:'center'}}>
      {/* Scope and Mode name their rows in this column; this row has nothing to
          say, so the reset lives here. It used to be a full-width bar that
          appeared under the filters the moment anything was changed, pushing the
          counts and the results down a row and pulling them back up again when
          it was pressed. The slot is already 38px whether or not anything is in
          it, so now nothing moves. Stretched rather than centred, so it is the
          height of the two buttons beside it to the pixel. */}
      <div style={{width:38,flexShrink:0,display:'flex',alignSelf:'stretch'}}>
        {searchOptsDirty&&(
          <button type="button" title="Reset to defaults" aria-label="Reset search options to defaults"
            onClick={()=>{setSearchOpts(SEARCH_DEFAULTS);if(readSearchQ.trim().length>=3)doReadSearch(undefined,SEARCH_DEFAULTS,true);}}
            style={{...ctrlRest,borderRadius:6,width:'100%',display:'flex',alignItems:'center',justifyContent:'center',padding:0,cursor:'pointer',transition:'background .12s,border-color .12s,color .12s'}}>
            {/* A circle turning back on itself: the same arrow the app draws
                everywhere else, 24-unit box and a 2px stroke in currentColor, so
                it takes the resting grey and lights with the rest of the bar. */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
        )}
      </div>
      {[['caseSensitive','Case Sensitive'],['partial','Partial Match']].map(([k,l])=>optBtn(searchOpts[k],l,()=>setOpt(k,!searchOpts[k]),true))}
    </div>
  </>);
  // The filter button is a pin. Pinned, the filters ride in the bar and stay
  // put while results scroll under them. Unpinned, they appear only on the
  // opening page, alongside the recent searches, and typing puts them away.
  const searchFiltersPinned=searchFieldOpen&&searchFiltersOpen;
  const searchFiltersInFlow=searchShowRecents&&!searchFiltersOpen;
  // Search owns the screen for as long as the field is open. It used to hand
  // the chapter back in the gap between the third character and the first
  // result — 350ms of debounce plus the search itself — where it sat under the
  // bar, visible and tappable. The field closing is what brings reading back.
  const readingHidden=searchFieldOpen||!!(readSearchRes&&readSearchResultsOpen);
  // Parsed once for everything that offers the jump, rather than per render site.
  const searchRef=useMemo(()=>parseReference(readSearchQ,versionLang(readVid)),[readSearchQ,readVid]);
  // Enter jumps to a typed reference only once the search for that exact text
  // has come back with nothing. Offering the jump on whether any results had
  // arrived yet made the same keystrokes do different things depending on how
  // fast they were typed: get ahead of the live search and "john" jumped to
  // John 1 instead of searching for the word. The row under the bar is still
  // there for a jump the reader actually wants.
  const refJump=searchRef&&readSearchRes&&readSearchRes.length===0&&readSearchResQ===readSearchQ.trim()?searchRef:null;
  // Jumping to a typed reference: the same landing a result row makes, minus
  // the search, since the reader told us exactly where they wanted to go.
  function goRefFromBar(ref){
    if(!ref)return;
    searchTypedRef.current=false;
    abandonSearch();
    setSearchFieldOpen(false);setSearchFiltersOpen(false);
    setReadSearchResultsOpen(false);
    const v=ref.verse||1;
    if(ref.book_num===readBook&&ref.chapter===readCh){
      setTimeout(()=>{const el=document.getElementById(`rv-${v}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});if(ref.verse)setReadSelVerses(new Set([v]));}},60);
    } else {
      readScrollToVerse.current=v;landSilent.current=true;setReadBook(ref.book_num);setReadCh(ref.chapter);
    }
  }
  // The bar is one row collapsed and two expanded, and two things are sized
  // against it, so it is measured rather than guessed at.
  // Measured before paint, not after: the bar mounts, the reading pane's top
  // padding follows from its height, and doing that in a post-paint effect cost a
  // second layout pass in the middle of the nav indicator's slide.
  useLayoutEffect(()=>{
    const el=searchBarRef.current;
    if(!searchBarOn||!el){setSearchBarH(0);return;}
    const measure=()=>setSearchBarH(h=>{const n=el.getBoundingClientRect().height;return Math.abs(n-h)<0.5?h:n;});
    measure();
    const ro=new RObserver(measure);
    ro.observe(el);
    return()=>ro.disconnect();
  },[searchBarOn,searchFieldOpen,searchFiltersOpen,searchTopBook,readSearchRes]);
  // A modal or a sheet can take the bar away without going through closeSearch,
  // and the wheel would be waiting, open, when the bar came back.
  useEffect(()=>{if(!searchBarOn)setBookWheelOpen(false);},[searchBarOn]);
  // The wheel used to sit behind a full-screen scrim, which is what stopped the
  // results being scrolled while it was open — and swallowed any drag that began
  // a few pixels off the wheel's 61px-wide strip, which is most of them. Closing
  // on a touch or a wheel anywhere else is this instead, so a gesture aimed past
  // the wheel scrolls the results and takes the wheel away with it, rather than
  // being eaten by a pane that looked like nothing was there.
  useEffect(()=>{
    if(!bookWheelOpen)return;
    const away=e=>{if(!(e.target instanceof Element)||!e.target.closest('[data-bookwheel]'))setBookWheelOpen(false);};
    document.addEventListener('pointerdown',away,true);
    document.addEventListener('wheel',away,{capture:true,passive:true});
    return()=>{document.removeEventListener('pointerdown',away,true);document.removeEventListener('wheel',away,{capture:true});};
  },[bookWheelOpen]);
  // Measured before paint so the wheel is never drawn at the wrong place first.
  // Rounded: the label sits at a fractional y inside a bar measured the same way,
  // and half a pixel would put the panel's border and its blur on a half-pixel
  // grid, which is a soft doubled edge on the one surface that must look like glass.
  useLayoutEffect(()=>{
    const el=bookLabelRef.current;
    if(!bookWheelOpen||!el){setBookLabelBox(null);return;}
    const r=el.getBoundingClientRect();
    setBookLabelBox({top:Math.round(r.top),left:Math.round(r.left)});
  },[bookWheelOpen,searchBarH,searchTopBook,searchBarOn]);
  // The jump-to-book wheel needs the handful of books a result set touches, and
  // this was rebuilding a Map over every result on every render of the reading
  // tab — with live search that would run on each keystroke as well as each
  // scroll.
  const searchBooks=useMemo(()=>readSearchRes?[...new Set(readSearchRes.map(r=>r.book_num))]:[],[readSearchRes]);
  // Moved up out of the results body when the right-edge scrubber went: the bar
  // sits above the list it scrolls, so what does the scrolling has to be reachable
  // from both. Past readSearchLimit the book has no row to scroll to yet, so it
  // parks the number and lets the effect on readSearchLimit finish the jump once
  // the rows exist. A book no longer in the results falls through both branches
  // harmlessly — findIndex gives -1, and scrollBookUnderBar finds no row.
  // scrollIntoView({block:'start'}) aligns to the scroll box, and the scroll box
  // runs up underneath the nav and the bar — so the book's first verse landed
  // behind them and the reader arrived looking at the middle of it. This puts it
  // just under the bar instead, using the same padding the pane already keeps
  // clear. Returns false when there is no row to scroll to yet, which is how the
  // deferred jump knows to hold on to the book number.
  function scrollBookUnderBar(bn){
    const el=readRef.current,a=document.getElementById('srch-bk-'+bn);
    if(!el||!a)return false;
    const pad=parseFloat(getComputedStyle(el).paddingTop)||0;
    const delta=a.getBoundingClientRect().top-el.getBoundingClientRect().top-pad-8;
    // Travelling, not appearing. The label is left out of it: every book the
    // blur passes would otherwise be a state change, and each one re-renders a
    // result list thousands of rows long — forty of those inside half a second
    // is what would turn the scroll back into a stutter. It is measured once,
    // when the scroll comes to rest or a thumb stops it.
    glideTo(el,el.scrollTop+delta,()=>trackSearchBook(el));
    return true;
  }
  function jumpToBook(bn){
    const idx=readSearchRes.findIndex(r=>r.book_num===parseInt(bn));
    // A page past the target, not just up to it: rendering exactly idx+1 rows
    // made the book the last row in the list, and a last row cannot be scrolled
    // to the top — the jump clamped and left it halfway down the screen.
    if(idx>=readSearchLimit){readSearchJumpTo.current=String(bn);setReadSearchLimit(Math.min(readSearchRes.length,idx+51));}
    else scrollBookUnderBar(bn);
  }
  // The book the bar is showing, which doubles as the way into the others the
  // results touch. Both rows of the bar show it at their own size, so it is built
  // once here the way optBtn and searchFilterRows are rather than written twice.
  const topBookLabel=(fs,maxW)=>{
    const nm=bookName(BIBLE.find(x=>x.n===searchTopBook),versionLang(readVid));
    const txt={fontFamily:FS,fontSize:fs,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:0};
    // One book in the results is nowhere to go, so it stays the plain label it
    // has always been rather than a control that does nothing.
    if(searchBooks.length<2)return <div style={{...txt,flexShrink:0,maxWidth:maxW}}>{nm}</div>;
    return (
      <button ref={bookLabelRef} type="button" title="Jump to book" aria-label={`Jump to book — showing ${nm}`}
        onClick={()=>setBookWheelOpen(o=>!o)}
        // Hidden rather than unmounted while the wheel stands in its place: the
        // wheel is positioned from this element's box, so the box has to stay.
        style={{visibility:bookWheelOpen?'hidden':'visible',display:'flex',alignItems:'center',gap:4,flexShrink:0,maxWidth:maxW,minWidth:0,
          background:'none',border:'none',cursor:'pointer',WebkitTapHighlightColor:'transparent',
          // Ten-point type is a small thing to aim a thumb at. The padding makes
          // the target the height of the row and the negative margin hands the
          // space straight back, so the bar's own spacing is unchanged. Vertical
          // only: a horizontal one would pull the label off the bar's left
          // padding the moment a second book turned up.
          padding:'7px 0',margin:'-7px 0'}}>
        <span style={txt}>{nm}</span>
        <svg width="9" height="6" viewBox="0 0 10 6" style={{flexShrink:0,display:'block',color:T.mut,transform:bookWheelOpen?'rotate(180deg)':'none',transition:'transform .2s ease'}}>
          <path d="M0 0L5 6L10 0" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    );
  };
  // Results as you type. Three characters rather than the dictionary's two: a
  // two-letter fragment matches a good part of the Bible and costs the most to
  // find. A committed search — Enter, the magnifier, a recent chip — goes
  // through doReadSearch directly and is unaffected by any of this.
  useEffect(()=>{
    if(readSearchTimer.current)clearTimeout(readSearchTimer.current);
    if(!searchTypedRef.current)return;
    const q=readSearchQ.trim();
    if(q.length<3)return;
    readSearchTimer.current=setTimeout(()=>{doReadSearch(undefined,undefined,true);},350);
    return()=>{if(readSearchTimer.current)clearTimeout(readSearchTimer.current);};
  },[readSearchQ,searchOpts,readVid]);
  // iOS scrolls the whole web view up to keep a focused input clear of the
  // keyboard, and leaves it pannable afterwards. The search field is already at
  // the top of the screen, so nothing needed revealing — all that gave was a
  // page that could be dragged until the app sat entirely above the keyboard.
  // Putting the offset back leaves the inner scrollers, which is everything the
  // app actually scrolls, untouched.
  useEffect(()=>{
    if(!searchFieldOpen)return;
    const pin=()=>{if(window.scrollX!==0||window.scrollY!==0)window.scrollTo(0,0);};
    window.addEventListener('scroll',pin,{passive:true});
    pin();
    return()=>window.removeEventListener('scroll',pin);
  },[searchFieldOpen]);
  // Tapping Bookmark opens the form rather than saving. The fields used to
  // sit in the strip, which meant filling them in before pressing the button
  // that used them -- discoverable only if you already knew.
  function doReadBookmark(){
    const sorted=[...readSelVerses].sort((a,b)=>a-b);
    const v=sorted[0];
    if(!user||!v)return;
    const ranges=[];let i=0;
    while(i<sorted.length){let s=sorted[i],e=s;while(i+1<sorted.length&&sorted[i+1]===e+1){i++;e=sorted[i];}ranges.push(s===e?`${s}`:`${s}-${e}`);i++;}
    const rangeRef=`${bookName(readBk,versionLang(readVid))} ${readCh}:${ranges.join(', ')}`;
    setBmDialog({verse:v,ref:rangeRef,note:'',cat:'',newCat:'',busy:false});
  }

  async function saveBookmarkFromDialog(){
    const d=bmDialog;
    if(!d||d.busy)return;
    setBmDialog(x=>({...x,busy:true}));
    let catId=d.cat;
    // A category typed here is created first, so the bookmark can point at it.
    if(d.cat==='__new'&&d.newCat.trim()){
      const made=await handleAddCategory(d.newCat.trim(),null);
      catId=made?made.id:null;
    }
    if(catId==='__new'||!catId)catId=null;
    // The label is always the reference. It is not the reader's to change, but
    // it is still written: the verse column holds one number, and the range a
    // bookmark covers survives only in the label's spelling of it.
    await handleAddBookmark({versionId:readVid,bookNum:readBook,chapter:readCh,verse:d.verse,
      label:d.ref,note:d.note.trim()||null,categoryId:catId});
    setBmDialog(null);
    setReadBmOk(true);setTimeout(()=>{setReadBmOk(false);dismissStrip();},1400);
  }

  async function copySelectedVerses(){
    const sorted=[...readSelVerses].sort((a,b)=>a-b);
    const verseLines=sorted.map(v=>{const row=readVerses.find(r=>r.verse===v);return row?{v,text:row.text.replace(/<[^>]*>/g,'')}:null;}).filter(Boolean);
    if(!verseLines.length)return;
    // Build range header: "Book Ch:V" or "Book Ch:V1-V2" or "Book Ch:V1-V2,V4,V6-V8"
    const bkDisplayName=bookName(readBk,versionLang(readVid))||'';
    const ranges=[];let i=0;
    while(i<sorted.length){let start=sorted[i],end=start;while(i+1<sorted.length&&sorted[i+1]===end+1){i++;end=sorted[i];}ranges.push(start===end?`${start}`:`${start}-${end}`);i++;}
    const header=`${bkDisplayName} ${readCh}:${ranges.join(',')}`;
    const sup=n=>[...String(n)].map(c=>'\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079'[c]).join('');
    const body=verseLines.map(({v,text})=>`${sup(v)} ${text}`).join('\n');
    const output=header+'\n'+body;
    try{await navigator.clipboard.writeText(output);}catch{
      const ta=document.createElement('textarea');ta.value=output;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    }
    setReadCopyOk(true);setTimeout(()=>{setReadCopyOk(false);dismissStrip();},1600);
  }

  // ── Audio file management ──
  const checkAudioFiles=async()=>{
    setAudioCheckStatus('checking');
    const check=async(path)=>{
      if(!Capacitor.isNativePlatform())return true;
      try{await Filesystem.getUri({directory:Directory.Documents,path});return true;}catch{return false;}
    };
    const[ot,nt]=await Promise.all([
      check('Audio/OT/KJV Reg/A01___01_Genesis_____ENGKJVO1DA.mp3'),
      check('Audio/NT/KJV Reg/B01___01_Matthew_____ENGKJVN1DA.mp3'),
    ]);
    setAudioCheckStatus({ot,nt});
  };

  const importAudioZip=async(file,pack)=>{
    setAudioImport({pack,current:0,total:0,error:null});
    try{
      // Helpers — only one file's data lives in memory at a time
      const rb=async(off,len)=>{if(!len)return new Uint8Array(0);return new Uint8Array(await file.slice(off,off+len).arrayBuffer());};
      const r16=(a,i)=>(a[i])|(a[i+1]<<8);
      const r32=(a,i)=>((a[i])|(a[i+1]<<8)|(a[i+2]<<16)|(a[i+3]<<24))>>>0;
      const r64=(a,i)=>r32(a,i)+r32(a,i+4)*0x100000000;
      const u8b64=(u8)=>{let s='';const C=32768;for(let i=0;i<u8.length;i+=C)s+=String.fromCharCode(...u8.subarray(i,Math.min(i+C,u8.length)));return btoa(s);};
      const inflate=async(data)=>{
        const ds=new DecompressionStream('deflate-raw');
        const w=ds.writable.getWriter();const rd=ds.readable.getReader();
        w.write(data);w.close();
        const ch=[];for(;;){const{done,value}=await rd.read();if(done)break;ch.push(value);}
        const out=new Uint8Array(ch.reduce((a,b)=>a+b.length,0));let o=0;
        for(const c of ch){out.set(c,o);o+=c.length;}return out;
      };

      // Find End-of-Central-Directory record
      const searchLen=Math.min(65558,file.size);
      const tail=await rb(file.size-searchLen,searchLen);
      let ei=-1;
      for(let i=tail.length-22;i>=0;i--)if(tail[i]===0x50&&tail[i+1]===0x4b&&tail[i+2]===0x05&&tail[i+3]===0x06){ei=i;break;}
      if(ei<0)throw new Error('Not a valid ZIP file');
      let numE=r16(tail,ei+10);let cdSz=r32(tail,ei+12);let cdOff=r32(tail,ei+16);

      // ZIP64 EOCD fallback
      if(cdOff===0xFFFFFFFF||cdSz===0xFFFFFFFF||numE===0xFFFF){
        const locAbs=file.size-searchLen+ei-20;
        if(locAbs>=0){
          const loc=await rb(locAbs,20);
          if(r32(loc,0)===0x07064b50){
            const z64=await rb(r64(loc,8),56);
            if(r32(z64,0)===0x06064b50){numE=r64(z64,32);cdSz=r64(z64,40);cdOff=r64(z64,48);}
          }
        }
      }

      // Read central directory (metadata only, ~75KB for 929 files)
      const cd=await rb(cdOff,cdSz);
      const prefix=pack==='NT'?'English_eng_KJV_NT_Non-Drama/':'';
      const entries=[];let pos=0;
      while(pos+46<=cd.length){
        if(r32(cd,pos)!==0x02014b50)break;
        const method=r16(cd,pos+10);
        let csize=r32(cd,pos+20);let usize=r32(cd,pos+24);
        const fnLen=r16(cd,pos+28);const exLen=r16(cd,pos+30);const cmLen=r16(cd,pos+32);
        let lhOff=r32(cd,pos+42);
        const name=new TextDecoder().decode(cd.subarray(pos+46,pos+46+fnLen));
        // Parse ZIP64 extra field if needed
        let ep=pos+46+fnLen;const ee=ep+exLen;
        while(ep+4<=ee){
          const hid=r16(cd,ep);const hsz=r16(cd,ep+2);
          if(hid===0x0001){
            let o=ep+4;
            if(usize===0xFFFFFFFF&&o+8<=ee){usize=r64(cd,o);o+=8;}
            if(csize===0xFFFFFFFF&&o+8<=ee){csize=r64(cd,o);o+=8;}
            if(lhOff===0xFFFFFFFF&&o+8<=ee){lhOff=r64(cd,o);o+=8;}
          }
          ep+=4+hsz;
        }
        if(!name.endsWith('/')&&name.toLowerCase().endsWith('.mp3')&&(!prefix||name.startsWith(prefix)))
          entries.push({method,csize,lhOff,name});
        pos+=46+fnLen+exLen+cmLen;
      }

      setAudioImport({pack,current:0,total:entries.length,error:null});

      // Extract and write one file at a time — peak memory ~2 MP3s
      for(let i=0;i<entries.length;i++){
        const{method,csize,lhOff,name}=entries[i];
        const filename=(prefix?name.slice(prefix.length):name).split('/').pop();
        if(!filename)continue;
        const lh=await rb(lhOff+26,4); // read local header filename+extra lengths
        const dataOff=lhOff+30+r16(lh,0)+r16(lh,2);
        const raw=await rb(dataOff,csize);
        const data=method===0?raw:method===8?await inflate(raw):null;
        if(!data)throw new Error(`Unsupported ZIP compression method ${method}`);
        await Filesystem.writeFile({path:`Audio/${pack}/KJV Reg/${filename}`,data:u8b64(data),directory:Directory.Documents,recursive:true});
        setAudioImport(s=>({...s,current:i+1}));
        if(i%5===0)await new Promise(r=>setTimeout(r,0));
      }
      localStorage.setItem(`scrip:audio:${pack.toLowerCase()}Installed`,'true');
      if(pack==='OT')setOtInstalled(true);else setNtInstalled(true);
      setAudioImport(null);
      setAudioCheckStatus(s=>s&&s!=='checking'?{...s,[pack.toLowerCase()]:true}:s);
    }catch(e){
      setAudioImport(s=>({...s,error:e.message||String(e)}));
    }
  };

  const removeAudioPack=async(pack)=>{
    try{await Filesystem.rmdir({path:`Audio/${pack}`,directory:Directory.Documents,recursive:true});}catch{}
    localStorage.removeItem(`scrip:audio:${pack.toLowerCase()}Installed`);
    if(pack==='OT')setOtInstalled(false);else setNtInstalled(false);
    setAudioCheckStatus(s=>s&&s!=='checking'?{...s,[pack.toLowerCase()]:false}:s);
  };

  // ── Entry CRUD ──
  function openAdd(){setModal({type:'entry',entry:{id:genId(),sectionId:'',reference:'',issueLabel:'',issueType:'manuscript',notes:'',greekHebrew:'',sourceRefs:'',versions:{},_isNew:true}});}
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

  async function moveSection(id,dir){
    setData(d=>{
      const idx=d.sections.findIndex(s=>s.id===id);
      const other=dir==='up'?idx-1:idx+1;
      if(idx<0||other<0||other>=d.sections.length)return d;
      const secs=[...d.sections];
      [secs[idx],secs[other]]=[secs[other],secs[idx]];
      const updated=secs.map((s,i)=>({...s,position:i}));
      // Persist both swapped positions asynchronously
      Promise.all([
        dbUpdateSectionPosition(updated[idx].id,updated[idx].position),
        dbUpdateSectionPosition(updated[other].id,updated[other].position),
      ]).catch(err=>console.error('moveSection:',err));
      return{...d,sections:updated};
    });
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

  // Answered by the delete confirmation below: true to go ahead.
  const[verDelAsk,setVerDelAsk]=useState(null); // {names,resolve}
  // Returns false if the reader backs out, so the editor stays open.
  async function saveVersions(vers,importedHere=[]){
    const keep=new Set(vers.map(v=>v.id));
    const saved=data?.versions||[];
    const pool=[...saved,...importedHere.filter(x=>!saved.some(v=>v.id===x.id))];
    const removed=pool.filter(v=>!keep.has(v.id)&&isOwnImport(v.id,user?.id));
    if(removed.length&&!(await new Promise(resolve=>setVerDelAsk({names:removed.map(v=>v.label),resolve}))))return false;
    setSaveStatus('saving');
    try{await dbSaveVersions(projectId,vers);setData(d=>({...d,versions:vers}));}
    catch(err){console.error('saveVersions:',err);}
    // The list is saved first. A delete that fails afterwards only means the
    // version comes back the way it always did -- nothing is lost.
    const failed=[];
    for(const v of removed){try{await deleteImportedVersion(v.id,user);}catch(err){console.error('deleteImportedVersion:',err);failed.push(v.label);}}
    if(failed.length)window.alert(`Couldn't finish deleting ${failed.join(', ')} — check your connection and remove ${failed.length===1?'it':'them'} again.`);
    {const gone=new Set(removed.filter(v=>!failed.includes(v.label)).map(v=>v.id));if(gone.size)setHighlights(hs=>hs.filter(h=>!gone.has(h.version_id)));}
    // Reading or comparing a version that is gone would load nothing.
    if(!keep.has(readVid)){const ref=vers.find(v=>v.isRef)||vers[0];if(ref)setReadVid(ref.id);}
    setParallelVids(p=>p.filter(id=>keep.has(id)));
    setModal(null);setSaveStatus('saved');
    return true;
  }

  async function handleAddBookmark(params){
    if(!user)return;
    if(user.guest){
      // Stored the way the database returns it: every reader -- the cards, the
      // category grouping, openFromBookmark -- looks for snake_case, so a guest
      // bookmark spread in camelCase resolved to no book and no version.
      const bm={id:'g-'+Date.now(),user_id:'guest',version_id:params.versionId,book_num:params.bookNum,
        chapter:params.chapter,verse:params.verse||null,label:params.label||null,
        category_id:params.categoryId||null,note:params.note||null};
      setBookmarks(b=>[bm,...b]);return;
    }
    const bm=await dbAddBookmark(user.id,params);if(bm)setBookmarks(b=>[bm,...b]);
  }
  async function handleDelBookmark(id){if(!user)return;await dbDeleteBookmark(id);setBookmarks(b=>b.filter(x=>x.id!==id));}
  async function handleUpdateBookmark(id,patch){
    // Map camelCase patch keys to snake_case so local state grouping works
    const sp={...patch};
    if('categoryId' in sp){sp.category_id=sp.categoryId;delete sp.categoryId;}
    setBookmarks(b=>b.map(x=>x.id===id?{...x,...sp}:x));
    if(user&&!user.guest)await dbUpdateBookmark(id,patch).catch(()=>{});
  }
  async function handleAddCategory(name,color){
    if(!user||user.guest)return;
    const cat=await dbAddCategory(user.id,{name,color});
    if(cat)setBmCategories(c=>[...c,cat]);
    return cat;
  }
  async function handleUpdateCategory(id,patch){
    setBmCategories(c=>c.map(x=>x.id===id?{...x,...patch}:x));
    if(user&&!user.guest)await dbUpdateCategory(id,patch).catch(()=>{});
  }
  async function handleDeleteCategory(id){
    // Move all bookmarks in this category to uncategorized
    setBookmarks(b=>b.map(x=>x.category_id===id?{...x,category_id:null}:x));
    setBmCategories(c=>c.filter(x=>x.id!==id));
    if(user&&!user.guest)await dbDeleteCategory(id).catch(()=>{});
  }
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
      setBookmarks([]);setRecents([]);setBmCategories([]);setHighlights([]);
      // Reset UI prefs
      setHiddenVers([]);setQ('');setFilters({issueTypes:[],statuses:[],vA:'',vB:''});setDark(true);setTab('read');
      localStorage.setItem('scrip:dark','true');localStorage.setItem('scrip:hidden','[]');
      // Re-seed with defaults (same logic as fresh user)
      setLoadMsg('Restoring defaults…');
      await dbSaveVersions(projectId,PUBLIC_VERSIONS);
      const s1id=await dbSaveSection({title:'Spanish / Espanol',description:'Use this section to make notes on Spanish Bible versions.',position:0,_isNew:true},projectId);
      await dbSaveSection({title:'English',description:'Use this section to compare English Bible versions.',position:1,_isNew:true},projectId);
      await dbSaveSection({title:'Albanian / Shqip',description:'Use this section to make notes on Albanian Bible versions.',position:2,_isNew:true},projectId);
      const refVid='kjv';
      const g11texts=await dbAutoFill(1,1,1,PUBLIC_VERSIONS.map(v=>v.id));
      const G11_FALLBACK={kjv:'In the beginning God created the heaven and the earth.',rvg:'En el principio creó Dios el cielo y la tierra.',p1602:'EN el principio creó Dios el cielo y la tierra.'};
      const vdata1={};for(const v of PUBLIC_VERSIONS){const txt=g11texts[v.id]||G11_FALLBACK[v.id]||'';if(txt)vdata1[v.id]={text:txt,status:v.id===refVid?'reference':'faithful'};}
      const e1={id:genId(),sectionId:s1id,reference:'Genesis 1:1',issueLabel:'',issueType:'manuscript',notes:'Some versions translate Genesis 1:1 "heaven" as plural. This is not accurate as God had only created one heaven at this point.',greekHebrew:'',sourceRefs:'',versions:vdata1,_isNew:true};
      await dbSaveEntry(e1,projectId);
      const pd2=await dbLoadProject(projectId);
      setData(pd2);
      setReadVid('kjv');setReadBook(1);setReadCh(1);
    }catch(err){console.error('reset error:',err);setLoadMsg('Reset failed: '+String(err.message||err));}
    setLoadMsg('');setReady(true);
  }

  // ── Auth gate ──
  // Ahead of the auth gates on purpose: the install runs before sign-in, so
  // anything rendered after those early returns is never reached while it matters.
  // One screen for the whole of start-up, and deliberately the same screen the
  // static markup in index.html has already painted: same type, same sizes, same
  // spacing, same shimmer. React taking over should look like nothing happened.
  //
  // So there is no entrance animation here. This used to fade and slide up on
  // mount — replaying an arrival for content already on the glass, in two
  // staggered halves — which is what read as the start-up restarting itself part
  // way through. The screen is not arriving; it is continuing.
  //
  // pct turns the shimmer into a fill without changing anything around it, so the
  // install phase is this screen telling you more rather than a third screen with
  // its own title size, its own bar and its own spacing.
  const LoadingScreen=({msg,pct})=>(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg,textAlign:'center',padding:'0 24px',boxSizing:'border-box'}}>
      <style>{CSS}</style>
      <div style={{fontFamily:FS,fontSize:UH(28),fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:8}}>Scriptorium</div>
      <div style={{fontFamily:FB,fontStyle:'italic',fontSize:U(14),color:D.gM,marginBottom:24,lineHeight:1.7}}>"The words of the LORD are pure words: as silver tried<br/>in a furnace of earth, purified seven times." — Psalm 12:6</div>
      <div style={{width:160,height:2,overflow:'hidden',background:D.bd,borderRadius:1,marginBottom:14}}>
        {pct==null
          ?<div style={{width:'100%',height:'100%',background:'linear-gradient(90deg,transparent,#c8a84e,transparent)',backgroundSize:'200% 100%',animation:'goldLine 1.5s ease-in-out infinite'}}/>
          :<div style={{width:pct+'%',height:'100%',background:'#c8a84e',transition:'width .25s ease'}}/>}
      </div>
      <div style={{fontFamily:FB,fontStyle:'italic',fontSize:U(15),color:D.gM}}>{msg}</div>
      {pct!=null&&<div style={{fontFamily:FS,fontSize:U(11),color:D.dim,letterSpacing:'0.08em',marginTop:6}}>{pct}%</div>}
    </div>
  );

  if(bundledInstall&&bundledInstall.total>0){
    const pct=Math.min(100,Math.round(bundledInstall.done/bundledInstall.total*100));
    return <LoadingScreen msg="Finalizing initial set-up" pct={pct}/>;
  }
  if(!authChecked)return <LoadingScreen msg="Loading…"/>;
  if(!user)return <AuthPanel onAuth={u=>setUser(u)}/>;
  if(recoveryMode)return <RecoveryPanel T={D} onDone={()=>setRecoveryMode(false)}/>;

  // ── Loading ──
  if(!ready||!data)return(
    <LoadingScreen msg={loadMsg||'Loading study data…'}/>
  );

  const filtered=getFiltered();
  const visibleVersions=data.versions.filter(v=>!hiddenVers.includes(v.id));
  // Lock background scroll areas when any sheet/modal is open (prevents iOS scroll-through on fixed overlays)
  const anySheetOpen=!!(readMobileSheet||mobileSheet||modal||parallelMobileSheet);
  // Red letter has two sources: <red> tags in the text, and the WOJ table of
  // verses spoken by Christ for texts that carry none -- which is every text
  // here, KJV included. Only the plain path consulted the table, so with
  // Strong's on, and now that every KJV chapter has Strong's data, nothing was
  // ever red. Every path that renders a reading verse goes through this.
  const wojWrap=(bk,ch,v,text)=>readRedLetter&&text&&!text.includes('<red>')&&isWOJ(bk,ch,v)?`<red>${text}</red>`:text;
  // The highlight is a band behind the words, not the verse's box: selection and
  // audio already use the box, and all three have to show at once.
  const hlStyle=v=>{const c=chapterHL[v];return c?{background:dark?hlByKey[c].dark:hlByKey[c].light,borderRadius:3,WebkitBoxDecorationBreak:'clone',boxDecorationBreak:'clone'}:{};};
  const selCols=[...readSelVerses].map(v=>chapterHL[v]);
  const selHL=selCols.length&&selCols.every(c=>c&&c===selCols[0])?selCols[0]:null;
  const anyHL=selCols.some(Boolean);

  return(
    <div style={{fontFamily:FB,background:T.bg,position:'fixed',inset:0,color:T.body,fontSize:16,display:'flex',flexDirection:'column',overflow:'hidden'}}>
      <style>{CSS}</style>

      {/* ═══ EMAIL VERIFIED WELCOME OVERLAY ═══ */}
      {authWelcome&&(
        <div className="modal-in" style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',padding:24}}>
          <div style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:16,width:'min(92vw,420px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.7)',textAlign:'center'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'40px 36px 36px'}}>
              <div style={{fontSize:UH(36),marginBottom:16}}>✓</div>
              <div style={{fontFamily:FS,fontSize:UH(17),fontWeight:700,color:D.gT,letterSpacing:'0.08em',marginBottom:12}}>Email Verified</div>
              <div style={{fontFamily:FB,fontSize:U(15),color:D.mut,lineHeight:1.8,marginBottom:28}}>
                Your account is confirmed. Welcome to Scriptorium — your Bible study workspace is ready.
              </div>
              <button type="button" onClick={()=>setAuthWelcome(false)}
                style={{width:'100%',background:D.gF,border:`1px solid ${D.gD}`,borderRadius:8,color:D.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.14em',textTransform:'uppercase',padding:'12px 0',fontWeight:600,cursor:'pointer'}}>
                Enter Scriptorium
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ HEADER ═══ */}
      <div ref={navRef} className="no-print app-header" style={{background:T.bgCard,borderBottom:`1px solid ${T.bdA}`,padding:'max(calc(var(--sat,0px) + 12px),var(--sat-min,20px)) 6px 6px',position:'fixed',top:0,left:0,right:0,zIndex:200,touchAction:'none',userSelect:'none',WebkitUserSelect:'none'}}>
        <div style={{height:3,background:T.accentLine,position:'absolute',top:'max(var(--sat,0px),var(--sat-min,0px))',left:0,right:0}}/>
        <div className="app-header-row" style={{display:'flex',alignItems:'center',gap:4,minHeight:0,overflow:'hidden',flexWrap:'nowrap'}}>
          {/* Logo */}
          <div className="hide-mobile" style={{flexShrink:0}}>
            <h1 style={{fontFamily:FS,fontSize:UH(17),fontWeight:700,color:T.gT,letterSpacing:'0.07em',margin:0,lineHeight:1}}>Scriptorium</h1>
            <div className="hide-mobile" style={{fontFamily:FS,fontSize:UL(8),color:T.gD,letterSpacing:'0.18em',textTransform:'uppercase',fontWeight:500,marginTop:2}}>{data.versions.map(v=>v.label).join(' - ')}</div>
          </div>
          {/* ── 6-button nav bar ── */}
          {(()=>{
            const studyActive=['parallel','compare','commentaries','strongs','dictionary','maps','charts','other'].includes(tab);
            const sheetOpen=!!readMobileSheet&&!readSheetClosing; // treat closing as already closed
            const anySheet=sheetOpen;
            const studyModalOpen=modal?.type==='bookmarks'||modal?.type==='highlights'||modal?.type==='recents';
            const studyIsActive=studyActive||studyModalOpen||((readMobileSheet==='studyTools')&&!readSheetClosing);
            const nonMajorSheet=(sheetOpen&&readMobileSheet!=='studyTools')||readSearchResultsOpen; // settings/search/version/nav, or search results visible
            const readIsActive=tab==='read'&&!studyIsActive;
            // Right pill indicator state. Whichever of the three sheets is open
            // wins: search used to light up for open search *results* as well, and
            // since results stay open after a search, the marker stayed pinned to
            // search however many other sheets were opened afterwards. Results
            // still light it, but only when no sheet is open to speak for itself.
            const rOpen=searchFieldOpen?'search':((!readSheetClosing&&(readMobileSheet==='nav'||readMobileSheet==='version'))?readMobileSheet:null);
            const rSearch=rOpen?rOpen==='search':readSearchResultsOpen;
            const rVersion=rOpen==='version';
            const rNav=rOpen==='nav';
            const rAny=rSearch||rVersion||rNav; // any right-pill sheet open
            // indicator left: search=3, nav=49 (default), version=95
            const rIndLeft=rSearch?3:rVersion?95:49;
            // soft=true → subtle dim: fill→bgCH, border→bdA, text→T.g
            const nb=(active,soft=false)=>({display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',transition:'background-color .04s ease-out,border-color .04s ease-out,color .04s ease-out',borderRadius:6,fontFamily:FS,letterSpacing:'0.07em',background:active?soft?T.bgCH:T.gF:'transparent',border:`1px solid ${active?soft?T.bdA:T.gD:'transparent'}`,color:active?soft?T.dim:T.gT:T.dim});
            const pill={display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3,gap:2,height:44,boxSizing:'border-box',alignItems:'stretch',flexShrink:0};
            return(
            <div style={{display:'flex',flex:1,gap:4,alignItems:'stretch',minWidth:0,boxSizing:'border-box'}}>
              {/* Settings pill */}
              <div style={pill}>
                {/* openReadSheet rather than setReadMobileSheet: settings is a sheet
                    like the book and version pickers, so it takes search down with
                    it. Setting the sheet directly left the results live underneath,
                    and the bar with them, reachable around the sheet's edges. */}
                <button type="button" title="Settings" {...navTap(()=>(readMobileSheet==='settings'&&!readSheetClosing)?closeReadSheet():openReadSheet('settings'))} style={{...nb(readMobileSheet==='settings'&&!readSheetClosing),width:44,fontSize:UH(17),display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
              </div>
              {/* The two buttons inside this pill carry 2px of horizontal padding
                  rather than 12. Both are flex:1 inside a flex:1 pill, so that
                  padding sets no visible width at the default -- it only sets the
                  min-content floor the row overflows at. The gear and tools pills
                  either side are fixed-width icons, which leaves this pill about
                  163px on a 375pt screen; the old padding put its floor past that
                  as soon as the labels grew. */}
              {/* Tab pill: Read | Study — sliding toggle indicator */}
              <div style={{...pill,flex:1,position:'relative'}}>
                {/* Sliding background indicator */}
                <div style={{position:'absolute',top:3,left:3,width:'calc(50% - 4px)',transform:studyIsActive?'translateX(calc(100% + 2px))':'translateX(0px)',willChange:'transform',height:'calc(100% - 6px)',background:nonMajorSheet?T.bgCH:T.gF,border:`1px solid ${nonMajorSheet?T.bdA:T.gD}`,borderRadius:5,pointerEvents:'none',zIndex:0,transition:`transform .15s cubic-bezier(0.4,0,0.2,1),background-color .04s ease-out,border-color .04s ease-out`}}/>
                <button type="button" onClick={()=>{closeSearch();if(readIsActive&&!readMobileSheet&&!readSearchResultsOpen&&!modal&&!readFullScreen.current){if(strongsPopup)closeStrongsPopup();setModal({type:'plan'});return;}closeModal();if(readFullScreen.current)exitFullScreen();if(readMobileSheet)closeReadSheet();if(tab==='parallel'){const same=parallelBk===readBook&&parallelCh===readCh;setReadBook(parallelBk);setReadCh(parallelCh);readScrollToVerse.current=parallelVs;if(same){setTimeout(()=>{const el=document.getElementById(`rv-${parallelVs}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(new Set([parallelVs]));setStripOpen(true);autoSel.current=true;readScrollToVerse.current=null;},80);}}if(tab==='commentaries'){const v=cmFocus?.v||null,same=cmBook===readBook&&cmCh===readCh;setReadBook(cmBook);setReadCh(cmCh);readScrollToVerse.current=v;if(same&&v){setTimeout(()=>{const el=document.getElementById(`rv-${v}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(new Set([v]));setStripOpen(true);autoSel.current=true;readScrollToVerse.current=null;},80);}}setTab('read');}} style={{position:'relative',zIndex:1,flex:1,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'1px solid transparent',borderRadius:6,cursor:'pointer',fontFamily:FS,letterSpacing:'0.07em',fontSize:UL(10.5),fontWeight:readIsActive?600:400,whiteSpace:'nowrap',padding:'0 2px',color:readIsActive?nonMajorSheet?T.dim:T.gT:T.dim,transition:'color .04s ease-out'}}>&#10022; Read</button>
                <button type="button" onClick={()=>{setSearchFieldOpen(false);if(readFullScreen.current)exitFullScreen();readMobileSheet==='studyTools'?closeReadSheet():setReadMobileSheet('studyTools');}} style={{position:'relative',zIndex:1,flex:1,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'1px solid transparent',borderRadius:6,cursor:'pointer',fontFamily:FS,letterSpacing:'0.07em',fontSize:UL(10.5),fontWeight:studyIsActive?600:400,whiteSpace:'nowrap',padding:'0 2px',color:studyIsActive?nonMajorSheet?T.dim:T.gT:T.dim,transition:'color .04s ease-out'}}>&#9998; Study</button>
              </div>
              {/* Tools pill: Search, Navigate, Version — sliding indicator anchored to Navigate */}
              <div style={{...pill,position:'relative'}}>
                {/* Sliding background indicator — defaults to Navigate (49px), slides to Search (3px) or Version (95px) */}
                {!studyActive&&<div style={{position:'absolute',top:3,left:3,width:44,height:'calc(100% - 6px)',transform:`translateX(${rIndLeft-3}px)`,willChange:'transform',background:rAny?T.gF:T.bgCH,border:`1px solid ${rAny?T.gD:T.bdA}`,borderRadius:5,pointerEvents:'none',zIndex:0,transition:`transform .15s cubic-bezier(0.4,0,0.2,1),background-color .04s ease-out,border-color .04s ease-out`}}/>}
                <button type="button" title="Search" {...navTap(tab==='compare'?()=>setMobileSheet('compareSearch'):!studyActive?()=>{searchIsOpen?closeSearch():openSearch();}:undefined)} style={{position:'relative',zIndex:1,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'1px solid transparent',borderRadius:6,cursor:'pointer',width:44,fontSize:UH(21),paddingLeft:2,color:rSearch?T.gT:T.dim,transition:'color .04s ease-out',visibility:tab==='compare'||!studyActive?'visible':'hidden'}}>
                  {readSearching&&!studyActive?<Spinner/>:'⌕'}
                </button>
                <button type="button" title="Navigate" {...navTap(tab==='parallel'||tab==='commentaries'||!studyActive?()=>{if(readMobileSheet==='nav'&&!readSheetClosing){closeReadSheet();}else{setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);openReadSheet('nav');}}:undefined)} style={{position:'relative',zIndex:1,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'1px solid transparent',borderRadius:6,cursor:'pointer',width:44,color:rNav?T.gT:T.dim,transition:'color .04s ease-out',visibility:tab==='parallel'||tab==='commentaries'||!studyActive?'visible':'hidden'}}>
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
                <button type="button" title="Select Version" {...navTap(!studyActive?()=>((readMobileSheet==='version'&&!readSheetClosing)?closeReadSheet():openReadSheet('version')):undefined)} style={{position:'relative',zIndex:1,display:'flex',alignItems:'center',justifyContent:'center',background:'transparent',border:'1px solid transparent',borderRadius:6,cursor:'pointer',width:44,fontSize:UL(10),fontWeight:600,padding:0,whiteSpace:'nowrap',color:studyActive?'transparent':rVersion?T.gT:T.dim,transition:'color .04s ease-out',visibility:studyActive?'hidden':'visible'}}>
                  {readVerLabel||'—'}
                </button>
              </div>
            </div>);
          })()}
          {/* Read controls (desktop only) - removed; now in 6-button nav */}
          {false&&<div className="hide-mobile" style={{display:'none'}}>
            <select className="s-btn" value={readVid||''} onChange={e=>setReadVid(e.target.value)}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.04em',padding:'0 6px',outline:'none',fontWeight:600,flexShrink:0}}>
              {(data?.versions||[]).map(v=><option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {/* Book */}
            <select className="s-btn" value={readBook} onChange={e=>{setReadBook(parseInt(e.target.value));setReadCh(1);}}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:U(11),padding:'0 4px',outline:'none',maxWidth:110}}>
              {BIBLE.map(b=><option key={b.n} value={b.n}>{bookName(b,versionLang(readVid))}</option>)}
            </select>
            {/* Chapter */}
            <select className="s-btn" value={readCh} onChange={e=>setReadCh(parseInt(e.target.value))}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:U(11),padding:'0 4px',outline:'none',width:48}}>
              {Array.from({length:readTotalCh},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
            {/* Verse */}
            <select className="s-btn" value="" onChange={e=>{const v=parseInt(e.target.value);if(v){const el=document.getElementById(`rv-${v}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});}}}
              style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FB,fontSize:U(11),padding:'0 4px',outline:'none',width:48}}>
              <option value="">Vs</option>
              {Array.from({length:readBk?.v?.[readCh-1]||0},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
            {/* Search */}
            <button type="button" className="s-btn s-ghost" title="Search" onClick={()=>doReadSearch()} disabled={readSearching}
              style={{height:33.33,boxSizing:'border-box',background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,padding:'0 8px',flexShrink:0,fontSize:UH(17),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>{readSearching?<Spinner/>:'⌕'}</button>
            <div style={{position:'relative',display:'inline-flex',flexShrink:0}}>
              <input value={readSearchQ} onChange={e=>{searchTypedRef.current=true;setReadSearchQ(e.target.value);if(e.target.value)setReadSearchPopover(true);}} onKeyDown={e=>e.key==='Enter'&&doReadSearch()}
                placeholder="Search…"
                style={{height:33.33,boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(11),padding:'0 26px 0 8px',outline:'none',width:150}}/>
              {readSearchQ&&(
                <button type="button" title="Clear" aria-label="Clear search" onMouseDown={e=>e.preventDefault()} onClick={()=>{searchTypedRef.current=false;setReadSearchQ('');}}
                  style={{position:'absolute',right:0,top:0,bottom:0,width:24,display:'flex',alignItems:'center',justifyContent:'center',background:'none',border:'none',outline:'none',color:T.dim,fontSize:U(12),lineHeight:1,cursor:'pointer',padding:0,WebkitTapHighlightColor:'transparent'}}>
                  ✕
                </button>
              )}
            </div>
            {/* Options toggle */}
            {(()=>{const act=searchOpts.scope!=='all'||searchOpts.mode!=='any'||searchOpts.caseSensitive||searchOpts.partial;return(
              <button type="button" title="Search options" onClick={()=>setReadSearchPopover(v=>!v)}
                style={{height:33.33,boxSizing:'border-box',background:readSearchPopover||act?T.gF:'none',border:`1px solid ${readSearchPopover||act?T.gD:T.bd}`,borderRadius:6,color:readSearchPopover||act?T.gT:T.dim,padding:'0 9px',flexShrink:0,fontSize:U(11),fontFamily:FS,letterSpacing:'0.05em',display:'flex',alignItems:'center',gap:3,cursor:'pointer',whiteSpace:'nowrap',transition:'all .15s'}}>
                ⊟{act&&<span style={{fontSize:UL(7),background:T.gM,color:'#fff',borderRadius:3,padding:'1px 3px',lineHeight:1}}>●</span>}
              </button>
            );})()}
            {readSearchRes&&<button type="button" title="Clear search" onClick={()=>{setReadSearchRes(null);setReadSearchQ('');setReadSearchResultsOpen(false);}} style={{background:'none',border:'none',color:T.dim,fontSize:U(14),cursor:'pointer',flexShrink:0,lineHeight:1}}>✕</button>}
            {/* Settings button + popover */}
            <button type="button" title="Reading settings" onClick={()=>setReadSettingsOpen(v=>!v)}
              style={{height:33.33,boxSizing:'border-box',background:readSettingsOpen?T.gF:'none',border:`1px solid ${readSettingsOpen?T.gD:T.bd}`,borderRadius:6,color:readSettingsOpen?T.gT:T.dim,padding:'0 9px',flexShrink:0,fontSize:U(14),display:'flex',alignItems:'center',cursor:'pointer',transition:'all .15s'}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
            {readSettingsOpen&&<>
              <div onClick={()=>setReadSettingsOpen(false)} style={{position:'fixed',inset:0,zIndex:499}}/>
              <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% + 8px)',right:0,zIndex:500,background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,padding:'16px 18px',width:260,boxShadow:'0 8px 32px rgba(0,0,0,0.28)'}}>
                <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.16em',color:T.gM,marginBottom:12,textTransform:'uppercase',fontWeight:600}}>Reading Settings</div>
                {/* Dark/light */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                  <span style={{fontFamily:FB,fontSize:U(13),color:T.mut}}>{dark?'Dark Mode':'Light Mode'}</span>
                  <button type="button" onClick={()=>setDark(d=>!d)}
                    style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:20,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'5px 12px',cursor:'pointer',fontWeight:600}}>
                    {dark?'☀︎ Light':'☾ Dark'}
                  </button>
                </div>
                {/* Strong's */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
                  <span style={{fontFamily:FB,fontSize:U(13),color:T.mut}}>Strong's Concordance</span>
                  <button type="button" onClick={()=>setStrongsMode(v=>!v)}
                    style={{background:strongsMode?T.gF:'transparent',border:`1px solid ${strongsMode?T.gD:T.bd}`,borderRadius:20,color:strongsMode?T.gT:T.dim,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'5px 12px',cursor:'pointer',fontWeight:strongsMode?600:400,transition:'all .15s'}}>
                    {strongsMode?'On':'Off'}
                  </button>
                </div>
                {/* Font size */}
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                    <span style={{fontFamily:FB,fontSize:U(13),color:T.mut}}>Text Size</span>
                    <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>{readFontSize}px</span>
                  </div>
                  <input type="range" min="13" max="60" value={readFontSize}
                    onChange={e=>{const v=Number(e.target.value);setReadFontSize(v);try{localStorage.setItem('scrip:fontSize',v);}catch{}}}
                    style={{width:'100%',accentColor:T.gM,cursor:'pointer'}}/>
                  <div style={{display:'flex',justifyContent:'space-between',marginTop:2,marginBottom:8}}>
                    <span style={{fontFamily:FS,fontSize:UL(8),color:T.dim}}>A</span>
                    <span style={{fontFamily:FS,fontSize:U(12),color:T.dim}}>A</span>
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
                  <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.16em',color:T.gM,marginBottom:6,textTransform:'uppercase',fontWeight:600}}>Scope</div>
                  <div style={{display:'flex',gap:4}}>
                    {[['all','All Scripture'],['ot','OT Only'],['nt','NT Only']].map(([v,l])=>(
                      <button key={v} type="button" onClick={()=>setSearchOpts(o=>({...o,scope:v}))}
                        style={{flex:1,background:searchOpts.scope===v?T.gF:'transparent',border:`1px solid ${searchOpts.scope===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.scope===v?T.gT:T.dim,fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Match mode */}
                <div style={{marginBottom:12}}>
                  <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.16em',color:T.gM,marginBottom:6,textTransform:'uppercase',fontWeight:600}}>Match Mode</div>
                  <div style={{display:'flex',gap:4}}>
                    {[['all','All Words'],['phrase','Phrase'],['any','Any Word']].map(([v,l])=>(
                      <button key={v} type="button" onClick={()=>setSearchOpts(o=>({...o,mode:v}))}
                        style={{flex:1,background:searchOpts.mode===v?T.gF:'transparent',border:`1px solid ${searchOpts.mode===v?T.gD:T.bd}`,borderRadius:6,color:searchOpts.mode===v?T.gT:T.dim,fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s',whiteSpace:'nowrap'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Toggles */}
                <div style={{display:'flex',gap:6,marginBottom:recentSearches.length>0?14:0}}>
                  {[['caseSensitive','Case Sensitive'],['partial','Partial Match']].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>setSearchOpts(o=>({...o,[k]:!o[k]}))}
                      style={{flex:1,background:searchOpts[k]?'rgba(210,60,60,0.13)':'transparent',border:`1px solid ${searchOpts[k]?'rgba(210,60,60,0.4)':T.bd}`,borderRadius:6,color:searchOpts[k]?(dark?'#e08888':'#bf4040'):T.dim,fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.05em',padding:'6px 4px',cursor:'pointer',transition:'all .12s'}}>
                      {l}
                    </button>
                  ))}
                </div>
                {/* Recent searches */}
                {recentSearches.length>0&&(
                  <div>
                    <div style={{height:1,background:T.bd,marginBottom:10}}/>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:7}}>
                      <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.16em',color:T.gM,textTransform:'uppercase',fontWeight:600}}>Recent Searches</div>
                      <button type="button" onClick={()=>{setRecentSearches([]);try{localStorage.removeItem('scrip_recent_searches');}catch{}}} style={{background:'none',border:'none',color:T.dim,fontSize:UL(9),cursor:'pointer',fontFamily:FS,letterSpacing:'0.06em'}}>clear all</button>
                    </div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
                      {recentSearches.map(r=>(
                        <button key={r} type="button" onClick={()=>doReadSearch(r)}
                          style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:5,color:T.mut,fontFamily:FB,fontSize:U(11),padding:'3px 9px',cursor:'pointer',transition:'background .1s'}}>
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
            {saveStatus==='saving'&&<span style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',fontWeight:500,color:T.gM}}>● Saving…</span>}
            <div style={{display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3,gap:2}}>
              <GhostBtn T={T} ch="✦ Bookmarks" onClick={()=>setModal({type:'bookmarks'})}/>
              <GhostBtn T={T} ch="↺ Recents" onClick={()=>setModal({type:'recents'})}/>
              <GhostBtn T={T} ch={dark?'☀︎':'☾'} onClick={()=>setDark(!dark)} title={dark?'Light mode':'Dark mode'}/>
              <GhostBtn T={T} ch="⋯" onClick={()=>setModal({type:'help'})} title="Help & more"/>
              <GhostBtn T={T} ch="§" onClick={()=>setModal({type:'about'})} title="About & Legal"/>
            </div>
            <div style={{display:'flex',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,padding:3}}>
              <button type="button" onClick={()=>Auth.signOut()} style={{background:'transparent',border:'1px solid transparent',borderRadius:6,color:T.body,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.08em',padding:'5px 11px',whiteSpace:'nowrap',cursor:'pointer',fontWeight:400}}>→ Sign Out</button>
            </div>
          </div>
          {saveStatus==='saving'&&<span className="show-mobile" style={{fontFamily:FS,fontSize:UL(9),color:T.gM,whiteSpace:'nowrap',flexShrink:0}}>● Saving…</span>}
        </div>
      </div>

      {/* Mobile menu sheet */}
      {mobileSheet==='menu'&&(
        <MobileSheet T={T} title={null} onClose={closeMobileSheet} isClosing={mobileSheetClosing} fromTop topOffset={navH}>
          <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
              <button type="button" onClick={closeMobileSheet}
                style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                ←
              </button>
            </div>
            <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>Menu</FitTitle>
          </div>
          {[
            {icon:'✦',label:'Bookmarks',fn:()=>{closeMobileSheet();setModal({type:'bookmarks'});}},
            {icon:'◐',label:'Highlights',fn:()=>{closeMobileSheet();setModal({type:'highlights'});}},
            {icon:'↺',label:'Recent Passages',fn:()=>{closeMobileSheet();setModal({type:'recents'});}},
            {icon:dark?'☀︎':'☾',label:dark?'Light Mode':'Dark Mode',fn:()=>setDark(!dark)},
            {icon:'⋯',label:'Help & Reference',fn:()=>{closeMobileSheet();setModal({type:'help'});}},
            {icon:'§',label:'About & Legal',fn:()=>{closeMobileSheet();setModal({type:'about'});}},
          ].map(item=>(
            <button key={item.label} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',width:'100%',marginBottom:6}}>
              <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>{item.icon}</span>{item.label}
            </button>
          ))}
          <div style={{height:1,background:T.bd,margin:'8px 0 10px'}}/>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:user?.guest?T.green:T.red,border:`1px solid ${user?.guest?T.greenTxt:T.redTxt}33`,borderRadius:9,color:user?.guest?T.greenTxt:T.redTxt,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',width:'100%'}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>{user?.guest?'Log In':'Sign Out'}
          </button>
          {!user?.guest&&!deleteAccountConfirm&&(
            <button type="button" onClick={()=>setDeleteAccountConfirm(true)}
              style={{background:'transparent',border:'none',color:T.dim,fontFamily:FB,fontSize:U(11),letterSpacing:'0.06em',padding:'10px 0 2px',width:'100%',textAlign:'center',cursor:'pointer'}}>
              Delete Account
            </button>
          )}
          {!user?.guest&&deleteAccountConfirm&&(
            <div style={{marginTop:10,background:T.bgSec,border:`1px solid ${T.redTxt}44`,borderRadius:9,padding:'14px 16px'}}>
              <div style={{fontFamily:FB,fontSize:U(13),color:T.redTxt,marginBottom:8,textAlign:'center'}}>Delete your account?</div>
              <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginBottom:14,textAlign:'center',lineHeight:1.6}}>This permanently deletes all your data — bookmarks, uploaded versions, and notes. This cannot be undone.</div>
              <div style={{display:'flex',gap:8}}>
                <button type="button" onClick={()=>setDeleteAccountConfirm(false)}
                  style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:U(13),padding:'9px 0',cursor:'pointer'}}>
                  Cancel
                </button>
                <button type="button" onClick={async()=>{const r=await Auth.deleteAccount();if(r.error)alert(r.error);setDeleteAccountConfirm(false);}}
                  style={{flex:1,background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:7,color:T.redTxt,fontFamily:FB,fontSize:U(13),padding:'9px 0',cursor:'pointer',fontWeight:600}}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </MobileSheet>
      )}

      {/* ═══ STUDY TOOLS DROPDOWN SHEET ═══ */}
      {readMobileSheet==='studyTools'&&(
        <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH}>
          <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
            <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
              <button type="button" onClick={closeReadSheet}
                style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                ←
              </button>
            </div>
            <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>Study Tools</FitTitle>
          </div>
          {/* Bookmarks, Highlights, Recent Passages: three across, each its icon
              over its name and nothing else, so the row stays short. */}
          <div style={{display:'flex',gap:8,marginBottom:12}}>
            {[
              {icon:'✦',label:'Bookmarks',type:'bookmarks'},
              {icon:'◐',label:'Highlights',type:'highlights'},
              {icon:'↺',label:'Recent Passages',type:'recents'},
            ].map(t=>(
              <div key={t.type} onClick={()=>{closeReadSheet();setModal({type:t.type,from:'study'});}} style={{flex:1,padding:'7px 4px',background:T.bgSec,border:`1.5px solid ${T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center',gap:3,minWidth:0}}>
                <span style={{fontFamily:FS,fontSize:U(15),color:T.gT,lineHeight:1}}>{t.icon}</span>
                <div style={{fontFamily:FB,fontSize:U(12),fontWeight:600,color:T.mut,lineHeight:1.2}}>{t.label}</div>
              </div>
            ))}
          </div>
          {[
            {icon:'☰',label:'Parallel',sub:'Compare the same verse across versions',key:'parallel',fn:()=>{setParallelVids(pv=>pv.length?pv:data.versions.map(v=>v.id));setParallelBk(readBook);setParallelCh(readCh);setParallelVs(readSelVerses.size>0?Math.min(...readSelVerses):1);setTab('parallel');closeReadSheet();}},
            {icon:'✎',label:'Compare',sub:'Study notes and verse analysis',key:'compare',fn:()=>{setTab('compare');closeReadSheet();}},
            {icon:'¶',label:'Commentaries',sub:'Cross-references and notes on the passage',key:'commentaries',fn:()=>{setCmBook(readBook);setCmCh(readCh);setCmFocus(readSelVerses.size>0?{v:Math.min(...readSelVerses)}:null);setTab('commentaries');closeReadSheet();}},
            {icon:'ℍ',label:"Strong's Concordance",sub:'Hebrew & Greek word study',key:'strongs',fn:()=>{setTab('strongs');closeReadSheet();}},
            {icon:'Δ',label:'Dictionary',sub:'Biblical definitions and references',key:'dictionary',fn:()=>{setTab('dictionary');closeReadSheet();}},
            {icon:null,iconSvg:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>,label:'Maps',sub:'Biblical maps and geography',key:'maps',fn:()=>{setTab('maps');closeReadSheet();}},
            {icon:'▦',label:'Charts',sub:'Timelines and visual references',key:'charts',fn:()=>{setTab('charts');closeReadSheet();}},
            {icon:'⋯',label:'Other Resources',sub:'Additional study materials',key:'other',fn:()=>{setTab('other');closeReadSheet();}},
          ].map(item=>(
            <button key={item.key} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:14,textAlign:'left',width:'100%',background:tab===item.key?T.gF:'transparent',border:`1px solid ${tab===item.key?T.gD:T.bd}`,borderRadius:9,color:tab===item.key?T.gT:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 16px',marginBottom:7}}>
              <span style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontSize:U(13),flexShrink:0,fontFamily:FS}}>{item.iconSvg||item.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FS,fontSize:U(16),fontWeight:600,letterSpacing:'0.05em',color:tab===item.key?T.gT:T.mut}}>{item.label}</div>
                <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginTop:2}}>{item.sub}</div>
              </div>
              {tab===item.key&&<span style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',color:T.gM}}>ACTIVE</span>}
            </button>
          ))}
        </MobileSheet>
      )}

      {/* ═══ SETTINGS SHEET (global, works from any tab) ═══ */}
      {readMobileSheet==='settings'&&(
        <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} maxSheetHeight={`${window.innerHeight-navH-bottomBarH-8}px`}>
          {/* Header row: back + absolutely centered title + dark mode pill */}
          <div style={{position:'relative',display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
            <button type="button" onClick={closeReadSheet}
              style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,zIndex:1}}>
              ←
            </button>
            <div style={{position:'absolute',left:0,right:0,textAlign:'center',fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',pointerEvents:'none'}}>Settings</div>
            {/* Dark mode pill — compact */}
            <div onClick={()=>setDark(d=>!d)} style={{position:'relative',width:72,height:32,borderRadius:16,background:T.bgCard,boxShadow:`0 0 0 1.5px ${T.gD},0 3px 10px rgba(0,0,0,${dark?0.5:0.12})`,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',flexShrink:0,transition:'background .3s,box-shadow .3s',overflow:'hidden'}}>
              <div style={{position:'absolute',top:0,bottom:0,left:dark?8:'auto',right:dark?'auto':8,display:'flex',alignItems:'center',justifyContent:'center',width:32,pointerEvents:'none'}}>
                <span style={{fontFamily:FS,fontSize:UL(7),fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',color:T.gT,lineHeight:1.2,textAlign:'center',transition:'color .3s'}}>{dark?'Dark':'Light'}</span>
              </div>
              <div style={{position:'absolute',top:3,left:dark?'calc(100% - 29px)':3,width:26,height:26,borderRadius:'50%',background:T.bgSec,boxShadow:`0 2px 6px rgba(0,0,0,${dark?0.5:0.18}),0 0 0 1px ${T.gD}`,display:'flex',alignItems:'center',justifyContent:'center',transition:'left .25s cubic-bezier(.4,0,.2,1),background .3s',fontSize:U(13)}}>
                {dark
                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:T.gT}}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{color:T.gT}}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                }
              </div>
            </div>
          </div>
          {/* Read-tab toggles: Strong's + Auto Fullscreen. Commentaries has its
              own full screen, and is read alongside Read, so they show there too. */}
          {(tab==='read'||tab==='commentaries')&&<div style={{display:'flex',gap:8,marginBottom:8}}>
            {/* Strong's card */}
            <div onClick={()=>readVid==='kjv'&&setStrongsMode(v=>!v)} title={readVid!=='kjv'?"Strong's numbers are only available for the KJV":undefined} style={{flex:1,padding:'9px 10px',background:strongsMode&&readVid==='kjv'?T.gF:T.bgSec,border:`1.5px solid ${strongsMode&&readVid==='kjv'?T.gD:T.bd}`,borderRadius:10,cursor:readVid==='kjv'?'pointer':'not-allowed',opacity:readVid==='kjv'?1:0.45,userSelect:'none',WebkitUserSelect:'none',transition:'background .2s,border-color .2s,opacity .2s',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:UH(18),color:strongsMode&&readVid==='kjv'?T.gT:T.dim,flexShrink:0,transition:'color .2s'}}>ℍ</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:U(12),fontWeight:600,color:strongsMode&&readVid==='kjv'?T.mut:T.dim,transition:'color .2s'}}>Strong's</div>
                <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim}}>{readVid==='kjv'?'Hebrew & Greek':'KJV only'}</div>
              </div>
              {readVid==='kjv'&&<span onClick={e=>{e.stopPropagation();setStrongsInfoVisible(v=>!v);}} style={{fontSize:U(11),color:T.gM,cursor:'pointer',flexShrink:0,padding:'8px',margin:'-8px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>}
            </div>
            {/* Auto Fullscreen card */}
            <div onClick={()=>{const v=!readAutoFullscreen;setReadAutoFullscreen(v);try{localStorage.setItem('scrip:autoFullscreen',JSON.stringify(v));}catch{};if(!v&&readFullScreen.current)exitFullScreen();}} style={{flex:1,padding:'9px 10px',background:readAutoFullscreen?T.gF:T.bgSec,border:`1.5px solid ${readAutoFullscreen?T.gD:T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',transition:'background .2s,border-color .2s',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:UH(18),color:readAutoFullscreen?T.gT:T.dim,flexShrink:0,transition:'color .2s'}}>⛶</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:U(12),fontWeight:600,color:readAutoFullscreen?T.mut:T.dim,transition:'color .2s'}}>Fullscreen</div>
                <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim}}>Auto on scroll</div>
              </div>
            </div>
          </div>}
          {strongsInfoVisible&&(tab==='read'||tab==='commentaries')&&<div style={{marginTop:-8,marginBottom:14,padding:'10px 14px',background:T.bgSec,border:`1px solid ${T.gD}`,borderRadius:9,display:'flex',gap:8,alignItems:'flex-start'}}>
            <span style={{color:T.gT,flexShrink:0}}>ⓘ</span>
            <span style={{fontFamily:FB,fontSize:U(13),color:T.mut,lineHeight:1.5}}>Underlines every word with its original Hebrew or Greek number. Tap any word to see its definition and every verse where it appears. KJV only.</span>
          </div>}
          {/* ── Appearance (universal accordion) ── */}
          <button type="button" onClick={()=>setSettingsAppOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:settingsAppOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s'}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>Aa</span>
            <span style={{flex:1,textAlign:'left'}}>Reading Appearance</span>
            <span style={{color:T.gM,display:'inline-flex',alignItems:'center',flexShrink:0}}><Caret open={settingsAppOpen}/></span>
          </button>
          {settingsAppOpen&&<div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'14px 14px 10px',marginBottom:0}}>

            {/* Menus & Buttons: the nav, labels and panels, on its own ramp and
                its own key. The readout is a percentage because that is what it
                is -- nothing here has a single pixel size to name. */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut}}>Menus & Buttons</span>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>{uiSize}%</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:FS,fontSize:U(9),color:T.dim,letterSpacing:'0.1em'}}>Aa</span>
                <input type="range" min="85" max="150" step="5" value={uiSize}
                  onChange={e=>{const v=Number(e.target.value);setUiSize(v);try{localStorage.setItem('scrip:uiSize',v);}catch{}}}
                  style={{flex:1,accentColor:T.gM,cursor:'pointer'}}/>
                <span style={{fontFamily:FS,fontSize:UH(15),color:T.dim,letterSpacing:'0.1em'}}>Aa</span>
              </div>
            </div>

            {/* Accent Color */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut}}>Accent Color</span>
                {accent==='custom'&&<button type="button" onClick={()=>{setAccent('gold');setCustomPickerOpen(false);}} style={{background:'transparent',border:'none',color:T.dim,fontFamily:FB,fontSize:U(12),padding:0,cursor:'pointer'}}>↺ Reset</button>}
              </div>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                {Object.entries(ACCENTS).map(([key,pal])=>(
                  <button key={key} title={key[0].toUpperCase()+key.slice(1)} type="button" onClick={()=>setAccent(key)}
                    style={{width:28,height:28,borderRadius:'50%',background:pal.dark.g,border:`2px solid ${accent===key?T.gT:T.bd}`,cursor:'pointer',boxShadow:accent===key?`0 0 0 2px ${T.g}`:'none',transition:'box-shadow .15s,border-color .15s',flexShrink:0}}/>
                ))}
                {/* Custom color swatch — pushed to the far right, opens custom modal */}
                <button type="button" title="Custom color" onClick={()=>{
                  const startHex=accent==='custom'?customAccentHex:((ACCENTS[accent]||ACCENTS.gold)[dark?'dark':'light'].g);
                  const[h,s,l]=hexToHsl(startHex);
                  pickerOrigRef.current={accent,hex:customAccentHex};
                  setPickerH(h);setPickerS(s);setPickerL(l);
                  setCustomAccentHex(startHex);setAccent('custom');
                  setCustomPickerOpen(true);
                }} style={{marginLeft:'auto',width:32,height:32,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',border:`2px solid ${accent==='custom'?T.gT:T.bd}`,boxShadow:accent==='custom'?`0 0 0 2px ${customAccentHex},0 2px 12px ${customAccentHex}66`:'0 1px 5px rgba(0,0,0,0.35)',transition:'box-shadow .2s,border-color .2s',padding:0,background:accent==='custom'?customAccentHex:'conic-gradient(hsl(0,100%,50%),hsl(30,100%,50%),hsl(60,100%,50%),hsl(90,100%,50%),hsl(120,100%,50%),hsl(150,100%,50%),hsl(180,100%,50%),hsl(210,100%,50%),hsl(240,100%,50%),hsl(270,100%,50%),hsl(300,100%,50%),hsl(330,100%,50%),hsl(360,100%,50%))'}}>
                  {accent==='custom'
                    ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{pointerEvents:'none',filter:'drop-shadow(0 1px 2px rgba(0,0,0,0.7))',flexShrink:0}}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    : <span style={{fontSize:U(13),color:'rgba(255,255,255,0.95)',fontWeight:700,textShadow:'0 1px 4px rgba(0,0,0,0.8)',lineHeight:1,pointerEvents:'none'}}>+</span>
                  }
                </button>
              </div>
            </div>

            {/* Scripture Size */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut}}>Scripture Size</span>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>{readFontSize}px</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:FB,fontSize:U(11),color:T.dim}}>A</span>
                <input type="range" min="13" max="60" value={readFontSize}
                  onChange={e=>{const v=Number(e.target.value);setReadFontSize(v);try{localStorage.setItem('scrip:fontSize',v);}catch{}}}
                  style={{flex:1,accentColor:T.gM,cursor:'pointer'}}/>
                <span style={{fontFamily:FB,fontSize:UH(20),color:T.dim}}>A</span>
              </div>
            </div>

            {/* Line Spacing */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut}}>Line Spacing</span>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>{readLineHeight.toFixed(1)}</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.dim}}>Tight</span>
                <input type="range" min="1.1" max="2.8" step="0.1" value={readLineHeight}
                  onChange={e=>{const v=Number(e.target.value);setReadLineHeight(v);try{localStorage.setItem('scrip:lineHeight',v);}catch{}}}
                  style={{flex:1,accentColor:T.gM,cursor:'pointer'}}/>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.dim}}>Wide</span>
              </div>
            </div>

            {/* Live preview */}
            {(()=>{
              const pvVerses=[
                {v:1,text:'The LORD <i>is</i> my shepherd; I shall not want.'},
                {v:2,text:'<red>I am the way, the truth, and the life.</red>'},
                {v:3,text:'God <i>is</i> love.'},
              ];
              const vnSup=(v)=>readVerseNums==='super'?<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:T.gM,marginRight:2,fontWeight:600}}>{v}</sup>:null;
              const vnInl=(v)=>readVerseNums==='inline'?<span style={{fontFamily:FS,fontSize:UL(10),color:T.gM,marginRight:6,fontWeight:600}}>{v}</span>:null;
              return(
              <div style={{borderTop:`1px solid ${T.bd}`,paddingTop:12,marginTop:4}}>
                <div style={{fontFamily:FS,fontSize:UL(7),letterSpacing:'0.14em',color:T.dim,textTransform:'uppercase',marginBottom:8}}>Preview</div>
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

            {/* Font Family */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,marginBottom:6}}>Font</div>
              <div style={{display:'flex',gap:4}}>
                {[['serif','Serif'],['sans','Sans-Serif'],['mono','Monospace']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadFontFamily(k);try{localStorage.setItem('scrip:fontFamily',k);}catch{}}}
                    style={{flex:1,background:readFontFamily===k?T.gF:'transparent',border:`1px solid ${readFontFamily===k?T.gD:T.bd}`,borderRadius:6,color:readFontFamily===k?T.gT:T.dim,fontFamily:k==='serif'?FB:k==='sans'?"'Inter','Segoe UI',system-ui,sans-serif":"'Courier New',monospace",fontSize:U(12),padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Text Alignment */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,marginBottom:6}}>Alignment</div>
              <div style={{display:'flex',gap:4}}>
                {[['left','Left'],['justify','Justified']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadTextAlign(k);try{localStorage.setItem('scrip:textAlign',k);}catch{}}}
                    style={{flex:1,background:readTextAlign===k?T.gF:'transparent',border:`1px solid ${readTextAlign===k?T.gD:T.bd}`,borderRadius:6,color:readTextAlign===k?T.gT:T.dim,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Verse Numbers */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,marginBottom:6}}>Verse Numbers</div>
              <div style={{display:'flex',gap:4}}>
                {[['super','Superscript'],['inline','Inline'],['hidden','Hidden']].map(([k,l])=>(
                  <button key={k} type="button" onClick={()=>{setReadVerseNums(k);try{localStorage.setItem('scrip:verseNums',k);}catch{}}}
                    style={{flex:1,background:readVerseNums===k?T.gF:'transparent',border:`1px solid ${readVerseNums===k?T.gD:T.bd}`,borderRadius:6,color:readVerseNums===k?T.gT:T.dim,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.05em',padding:'7px 4px',cursor:'pointer',transition:'all .12s'}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles row */}
            <div style={{display:'flex',gap:6,marginBottom:14}}>
              <button type="button" onClick={()=>{const v=!readParaMode;setReadParaMode(v);try{localStorage.setItem('scrip:paraMode',JSON.stringify(v));}catch{}}}
                style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:readParaMode?T.gF:'transparent',border:`1px solid ${readParaMode?T.gD:T.bd}`,borderRadius:6,color:readParaMode?T.gT:T.dim,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.05em',padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                <span>Paragraph Mode</span><span style={{fontSize:UL(8),opacity:0.7}}>{readParaMode?'ON':'OFF'}</span>
              </button>
              <button type="button" onClick={()=>{const v=!readRedLetter;setReadRedLetter(v);try{localStorage.setItem('scrip:redLetter',JSON.stringify(v));}catch{}}}
                style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:readRedLetter?'rgba(198,40,40,0.15)':'transparent',border:`1px solid ${readRedLetter?'#c62828':T.bd}`,borderRadius:6,color:readRedLetter?'#ef5350':T.dim,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.05em',padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                <span>Red Letter</span><span style={{fontSize:UL(8),opacity:0.7}}>{readRedLetter?'ON':'OFF'}</span>
              </button>
            </div>

            {/* Last thing in the section, and quieter than the controls above it:
                a ghost button rather than a filled one, so it reads as a way out
                rather than another setting to try. */}
            <button type="button" onClick={resetAppearance}
              style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:7,
                background:'transparent',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,
                fontFamily:FS,fontSize:UL(10),letterSpacing:'0.05em',padding:'9px 10px',
                marginBottom:14,cursor:'pointer',transition:'all .12s'}}>
              <span style={{fontSize:UL(11),lineHeight:1}}>{'\u21ba'}</span>
              <span>Reset Appearance Settings</span>
            </button>

          </div>}
          {/* ── AUDIO SETTINGS ── */}
          {tab==='read'&&(
          <button type="button" onClick={()=>setAudioSettingsOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:audioSettingsOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>♪</span>
            <span style={{flex:1,textAlign:'left'}}>Audio Playback</span>
            <span style={{color:T.gM,display:'inline-flex',alignItems:'center',flexShrink:0}}><Caret open={audioSettingsOpen}/></span>
          </button>
          )}

          {audioSettingsOpen&&tab==='read'&&<div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'14px 14px 10px',marginBottom:0}}>

            {/* Auto-scroll + Auto-advance row */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',gap:4,marginBottom:audioInfoOpen?4:0}}>
                <button type="button" onClick={()=>{const v=!audioAutoScroll;setAudioAutoScroll(v);try{localStorage.setItem('scrip:audio:autoScroll',JSON.stringify(v));}catch{}}}
                  style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:audioAutoScroll?T.gF:'transparent',border:`1px solid ${audioAutoScroll?T.gD:T.bd}`,borderRadius:6,color:audioAutoScroll?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                  <span>Auto-scroll</span>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <span style={{fontSize:UL(9),opacity:0.7}}>{audioAutoScroll?'ON':'OFF'}</span>
                    <span onClick={e=>{e.stopPropagation();setAudioInfoOpen(v=>v==='scroll'?null:'scroll');}} style={{fontSize:U(11),color:T.gM,cursor:'pointer',lineHeight:1,userSelect:'none',WebkitUserSelect:'none',padding:'6px',margin:'-6px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>
                  </div>
                </button>
                <button type="button" onClick={()=>{const v=!audioAutoAdvance;setAudioAutoAdvance(v);try{localStorage.setItem('scrip:audio:autoAdvance',JSON.stringify(v));}catch{}}}
                  style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:audioAutoAdvance?T.gF:'transparent',border:`1px solid ${audioAutoAdvance?T.gD:T.bd}`,borderRadius:6,color:audioAutoAdvance?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                  <span>Auto-advance</span>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <span style={{fontSize:UL(9),opacity:0.7}}>{audioAutoAdvance?'ON':'OFF'}</span>
                    <span onClick={e=>{e.stopPropagation();setAudioInfoOpen(v=>v==='advance'?null:'advance');}} style={{fontSize:U(11),color:T.gM,cursor:'pointer',lineHeight:1,userSelect:'none',WebkitUserSelect:'none',padding:'6px',margin:'-6px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>
                  </div>
                </button>
              </div>
              {audioInfoOpen&&<div style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:6,padding:'7px 10px',fontSize:U(11),fontFamily:FB,color:T.dim,lineHeight:1.5}}>
                {audioInfoOpen==='scroll'
                  ?'Automatically scrolls the page to keep the currently reading verse visible.'
                  :audioInfoOpen==='advance'
                  ?'Automatically loads and plays the next chapter when the current one ends.'
                  :'Keeps the screen on while audio is playing so the display does not lock.'}
              </div>}
            </div>

            {/* Keep screen awake */}
            <div style={{marginBottom:14}}>
              <button type="button" onClick={()=>{const v=!audioKeepAwake;setAudioKeepAwake(v);try{localStorage.setItem('scrip:audio:keepAwake',JSON.stringify(v));}catch{}}}
                style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'space-between',background:audioKeepAwake?T.gF:'transparent',border:`1px solid ${audioKeepAwake?T.gD:T.bd}`,borderRadius:6,color:audioKeepAwake?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                <span>Keep screen on</span>
                <div style={{display:'flex',alignItems:'center',gap:5}}>
                  <span style={{fontSize:UL(9),opacity:0.7}}>{audioKeepAwake?'ON':'OFF'}</span>
                  <span onClick={e=>{e.stopPropagation();setAudioInfoOpen(v=>v==='keepAwake'?null:'keepAwake');}} style={{fontSize:U(11),color:T.gM,cursor:'pointer',lineHeight:1,userSelect:'none',WebkitUserSelect:'none',padding:'6px',margin:'-6px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>
                </div>
              </button>
            </div>

            {/* Playback Source */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,marginBottom:6}}>Source</div>
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <div style={{display:'flex',gap:4}}>
                  {[['auto','Auto'],['off','Off']].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>{setAudioSource(k);try{localStorage.setItem('scrip:audio:source',k);}catch{}}}
                      style={{flex:1,background:audioSource===k?T.gF:'transparent',border:`1px solid ${audioSource===k?T.gD:T.bd}`,borderRadius:6,color:audioSource===k?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',height:'36px',boxSizing:'border-box',lineHeight:'1'}}>
                      {l}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={()=>{setAudioSource('local');try{localStorage.setItem('scrip:audio:source','local');}catch{}}}
                  style={{background:audioSource==='local'?T.gF:'transparent',border:`1px solid ${audioSource==='local'?T.gD:T.bd}`,borderRadius:audioSource==='local'&&Capacitor.isNativePlatform()?'6px 6px 0 0':'6px',color:audioSource==='local'?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',height:'36px',boxSizing:'border-box',lineHeight:'1'}}>
                  KJV Audio{Capacitor.isNativePlatform()&&(!otInstalled||!ntInstalled)&&<span style={{fontFamily:FB,fontSize:UL(9),color:T.dim,marginLeft:6}}>{otInstalled||ntInstalled?'· partial':'· import required'}</span>}
                </button>
                {audioSource==='local'&&Capacitor.isNativePlatform()&&(
                  <div style={{border:`1px solid ${T.gD}`,borderTop:'none',borderRadius:'0 0 6px 6px',padding:'10px',marginBottom:2}}>
                    {audioImport?(
                      <>
                        <div style={{fontFamily:FB,fontSize:U(12),color:T.mut,marginBottom:6}}>
                          Extracting {audioImport.pack==='OT'?'Old Testament':'New Testament'}...
                          {audioImport.total>0&&` (${audioImport.current} / ${audioImport.total})`}
                        </div>
                        {audioImport.total>0&&(
                          <div style={{height:4,background:T.bd,borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${Math.round((audioImport.current/audioImport.total)*100)}%`,background:T.gT,borderRadius:2,transition:'width .2s'}}/>
                          </div>
                        )}
                        {audioImport.error&&<div style={{fontFamily:FB,fontSize:U(11),color:'#ef5350',marginTop:6}}>{audioImport.error}</div>}
                      </>
                    ):(
                      <>
                        {/* Both packs installed: the instructions and the walkthrough
                            have nothing left to say, so leave just the status cards. */}
                        {!(otInstalled&&ntInstalled)&&(
                          <>
                            <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,lineHeight:1.6,marginBottom:8}}>
                              Download the free KJV MP3 packs from faithcomesbyhearing.com, then import each ZIP file below.
                            </div>
                            <button type="button" onClick={()=>setModal({type:'audiohelp'})}
                              style={{display:'flex',alignItems:'center',gap:7,width:'100%',boxSizing:'border-box',background:T.bgCard,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FB,fontSize:U(12),padding:'9px 11px',cursor:'pointer',marginBottom:10,textAlign:'left'}}>
                              {audioHelpVideo&&<span style={{flexShrink:0,color:T.gT,display:'inline-flex',alignItems:'center'}}><PlayMark/></span>}
                              <span>{audioHelpVideo?'Watch how to do this':'Step-by-step instructions'}</span>
                            </button>
                          </>
                        )}
                        <div style={{display:'flex',gap:6,marginBottom:8}}>
                          {[
                            {pack:'OT',label:'Old Testament',installed:otInstalled,url:'https://www.faithcomesbyhearing.com/audio-bible-resources/mp3-downloads?language=English&version=ENGKJVO1DA'},
                            {pack:'NT',label:'New Testament',installed:ntInstalled,url:'https://www.faithcomesbyhearing.com/audio-bible-resources/mp3-downloads?language=English&version=ENGKJVN1DA'}
                          ].map(({pack,label,installed,url})=>(
                            <div key={pack} style={{flex:1,background:installed?'rgba(98,196,132,0.08)':T.bgCard,border:`1px solid ${installed?'#62c484':T.bd}`,borderRadius:6,padding:'8px'}}>
                              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                                <span style={{fontFamily:FB,fontSize:U(11),color:installed?'#62c484':T.mut}}>{installed?'✓ ':''}{label}</span>
                                {installed&&<button onClick={()=>removeAudioPack(pack)} style={{background:'none',border:'none',color:T.dim,fontFamily:FB,fontSize:U(11),cursor:'pointer',padding:0}}>✕</button>}
                              </div>
                              {!installed&&(
                                <>
                                  <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim,marginBottom:4}}>1. Download</div>
                                  <a href={url} target="_blank" rel="noreferrer" onClick={e=>{e.preventDefault();openExternal(url);}}
                                    style={{display:'block',width:'100%',boxSizing:'border-box',background:'transparent',border:`1px solid ${T.gD}`,borderRadius:4,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'6px 0',cursor:'pointer',textAlign:'center',textDecoration:'none',marginBottom:8}}>
                                    Download {pack} File
                                  </a>
                                  <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim,marginBottom:4}}>2. Import</div>
                                  <input id={`audiozip-${pack}`} type="file" accept=".zip" style={{display:'none'}}
                                    onChange={e=>{const f=e.target.files[0];if(f)importAudioZip(f,pack);e.target.value='';}}/>
                                  <button onClick={()=>document.getElementById(`audiozip-${pack}`).click()}
                                    style={{width:'100%',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:4,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'6px 0',cursor:'pointer'}}>
                                    Import {pack} File (.ZIP)
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div style={{display:'flex',gap:4,alignItems:'center'}}>
                  <button type="button" onClick={()=>{setAudioSource('speech');try{localStorage.setItem('scrip:audio:source','speech');}catch{}}}
                    style={{flex:1,background:audioSource==='speech'?T.gF:'transparent',border:`1px solid ${audioSource==='speech'?T.gD:T.bd}`,borderRadius:6,color:audioSource==='speech'?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',lineHeight:'1',boxSizing:'border-box',height:'36px',whiteSpace:'nowrap'}}>
                    Browser Voice (any language)
                  </button>
                  <select value={voicesByVersion[readVid]||''} onChange={e=>{const name=e.target.value;setVoicesByVersion(prev=>{const next={...prev};if(name)next[readVid]=name;else delete next[readVid];return next;});}}
                    style={{flex:1,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(12),padding:'8px 4px',outline:'none',boxSizing:'border-box',lineHeight:'1',WebkitAppearance:'auto',appearance:'auto',height:'36px',overflow:'hidden'}}>
                    <option value="">Default for language</option>
                    {availableVoices.map((v,i)=><option key={i} value={v.name}>{v.name} ({v.lang})</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* FCBH API Key (if streaming selected) */}
            {audioSource==='fcbh'&&(
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,marginBottom:6}}>FCBH API Key</div>
              <input type="password" placeholder="Enter FCBH API key..."
                defaultValue={localStorage.getItem('scrip:audio:fcbhKey')||''}
                onBlur={e=>{try{localStorage.setItem('scrip:audio:fcbhKey',e.target.value);}catch{}}}
                style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(12),padding:'8px 10px',outline:'none',boxSizing:'border-box'}}/>
              <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginTop:6}}>Get free at <span style={{color:T.gT}}>bible.faithcomesbyhearing.com</span></div>
            </div>
            )}

            {/* Playback Speed */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut}}>Speed</span>
                <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>{audioRate.toFixed(2)}x</span>
              </div>
              <input type="range" min="0.5" max="2" step="0.25" value={audioRate}
                onChange={e=>{const v=Number(e.target.value);setAudioRate(v);try{localStorage.setItem('scrip:audio:rate',v);}catch{}}}
                style={{width:'100%',accentColor:T.gM,cursor:'pointer'}}/>
            </div>

            {audioError&&<div style={{padding:'10px 12px',background:'rgba(198,40,40,0.1)',border:`1px solid rgba(198,40,40,0.3)`,borderRadius:6,color:'#ef5350',fontFamily:FB,fontSize:U(12),marginBottom:14}}>
              {audioError}
            </div>}

          </div>}

          {/* ── Offline Data accordion ── */}
          <button type="button" onClick={()=>setOfflineDataOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:offlineDataOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s',marginTop:8}}>
            <span style={{width:22,display:'flex',alignItems:'center',justifyContent:'center',color:T.gT,flexShrink:0}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </span>
            <span style={{flex:1,textAlign:'left'}}>Offline Data</span>
            <span style={{color:T.gM,display:'inline-flex',alignItems:'center',flexShrink:0}}><Caret open={offlineDataOpen}/></span>
          </button>
          {offlineDataOpen&&(()=>{
            const offlineItems=[
              {id:'strongs',label:"Strong's Concordance",sub:'Definitions, word mapping & KJV occurrences',icon:'ℍ'},
              {id:'webster',label:"Webster's 1828",sub:'107,793 entries · ~50 MB',icon:'W'},
            ];
            return(
              <div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'10px 12px 12px',marginBottom:0}}>
                {/* Strong's + Webster download rows */}
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {offlineItems.map(item=>{
                    const dl=dlStates[item.id]||{};
                    const pct=dl.total>0?Math.round((dl.progress/dl.total)*100):0;
                    return(
                      <div key={item.id} style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:8,padding:'9px 12px'}}>
                        <div style={{display:'flex',alignItems:'center',gap:10}}>
                          <span style={{fontFamily:FS,fontSize:U(16),color:T.gT,width:22,textAlign:'center',flexShrink:0}}>{item.icon}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontFamily:FB,fontSize:U(13),fontWeight:600,color:T.mut}}>{item.label}</div>
                            <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim}}>{item.sub}</div>
                          </div>
                          {dl.downloading?(
                            <span style={{fontFamily:FS,fontSize:UL(10),color:T.gM,letterSpacing:'0.06em',flexShrink:0}}>{pct}%</span>
                          ):dl.downloaded?(
                            <button onClick={()=>deleteDownload(item.id)} style={{background:'none',border:`1px solid ${T.gD}`,borderRadius:6,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>✓ Offline</button>
                          ):(
                            <button onClick={()=>startDownload(item.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>↓ Download</button>
                          )}
                          {dl.err&&<span style={{fontFamily:FB,fontSize:UL(10),color:T.redTxt}}>Error</span>}
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
                {/* Downloaded bible versions */}
                {(data?.versions||[]).filter(v=>PUBLIC_VERSIONS.some(pv=>pv.id===v.id)).length>0&&(
                  <div style={{marginTop:8}}>
                    <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:6,paddingLeft:2}}>BIBLE VERSIONS</div>
                    <div style={{display:'flex',flexDirection:'column',gap:6}}>
                      {(data?.versions||[]).filter(v=>PUBLIC_VERSIONS.some(pv=>pv.id===v.id)).map(v=>{
                        const dl=dlStates[v.id]||{};
                        const pct=dl.total>0?Math.round((dl.progress/dl.total)*100):0;
                        return(
                          <div key={v.id} style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:8,padding:'9px 12px'}}>
                            <div style={{display:'flex',alignItems:'center',gap:10}}>
                              <span style={{fontFamily:FS,fontSize:U(11),fontWeight:700,color:T.gT,width:45,textAlign:'center',flexShrink:0,letterSpacing:'0.04em'}}>{v.label}</span>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontFamily:FB,fontSize:U(13),fontWeight:600,color:T.mut}}>{v.label} Bible</div>
                                <div style={{fontFamily:FB,fontSize:UL(10),color:T.dim}}>{v.lang} · {v.id.toUpperCase()}</div>
                              </div>
                              {dl.downloading?(
                                <span style={{fontFamily:FS,fontSize:UL(10),color:T.gM,letterSpacing:'0.06em',flexShrink:0}}>{pct}%</span>
                              ):dl.downloaded?(
                                <button onClick={()=>deleteDownload(v.id)} style={{background:'none',border:`1px solid ${T.gD}`,borderRadius:6,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>✓ Offline</button>
                              ):(
                                <button onClick={()=>startDownload(v.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>↓ Download</button>
                              )}
                              {dl.err&&<span style={{fontFamily:FB,fontSize:UL(10),color:T.redTxt}}>Error</span>}
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
                )}
              </div>
            );
          })()}
          <button type="button" className="s-btn s-ghost" onClick={()=>{closeReadSheet();setModal({type:'help'});}}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>⋯</span>Help & Reference
          </button>
          <button type="button" className="s-btn s-ghost" onClick={()=>{closeReadSheet();setModal({type:'about'});}}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>§</span>About & Legal
          </button>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:user?.guest?T.green:T.red,border:`1px solid ${user?.guest?T.greenTxt:T.redTxt}33`,borderRadius:9,color:user?.guest?T.greenTxt:T.redTxt,fontFamily:FB,fontSize:UH(18),padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>{user?.guest?'Log In':'Sign Out'}
          </button>
          {user?.email&&<div style={{fontFamily:FB,fontSize:U(12),color:T.dim,textAlign:'center',marginTop:8,padding:'0 4px'}}>Signed in as <span style={{color:T.gM}}>{user.email}</span></div>}
          {!user?.guest&&!deleteAccountConfirm&&(
            <button type="button" onClick={()=>setDeleteAccountConfirm(true)}
              style={{background:'transparent',border:'none',color:T.dim,fontFamily:FB,fontSize:U(11),letterSpacing:'0.06em',padding:'10px 0 2px',width:'100%',textAlign:'center',cursor:'pointer'}}>
              Delete Account
            </button>
          )}
          {!user?.guest&&deleteAccountConfirm&&(
            <div style={{marginTop:10,background:T.bgSec,border:`1px solid ${T.redTxt}44`,borderRadius:9,padding:'14px 16px'}}>
              <div style={{fontFamily:FB,fontSize:U(13),color:T.redTxt,marginBottom:8,textAlign:'center'}}>Delete your account?</div>
              <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginBottom:14,textAlign:'center',lineHeight:1.6}}>This permanently deletes all your data — bookmarks, uploaded versions, and notes. This cannot be undone.</div>
              <div style={{display:'flex',gap:8}}>
                <button type="button" onClick={()=>setDeleteAccountConfirm(false)}
                  style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:U(13),padding:'9px 0',cursor:'pointer'}}>
                  Cancel
                </button>
                <button type="button" onClick={async()=>{const r=await Auth.deleteAccount();if(r.error)alert(r.error);setDeleteAccountConfirm(false);}}
                  style={{flex:1,background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:7,color:T.redTxt,fontFamily:FB,fontSize:U(13),padding:'9px 0',cursor:'pointer',fontWeight:600}}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </MobileSheet>
      )}

      {/* ── Global popup sheets (nav / version / search) ── */}
          {readMobileSheet==='nav'&&(()=>{
            const isP=tab==='parallel',isC=tab==='commentaries';
            const setNavBk=isP?setParallelBk:isC?setCmBook:setReadBook;
            const setNavCh=isP?setParallelCh:isC?setCmCh:setReadCh;
            const pickedBkData=navPickedBk?BIBLE.find(b=>b.n===navPickedBk):null;
            const gridBtn={border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FS,fontSize:UH(17),letterSpacing:'0.04em',padding:'12px 4px',cursor:'pointer',textAlign:'center',background:T.bgIn,minWidth:0};
            /* Dynamic book button height: fit all 22 rows (13 OT + 9 NT) without scrolling.
               Overhead: sheet padding 52+32, marginTop -44, header 28, line 11, OT label 30, NT label 25,
               grid gaps 12*2+8*2=40, paddingBottom 12, sheet border 2 ≈ 188px */
            /* 5 columns: OT=8 rows, NT=6 rows, total 14 rows */
            const bookBtnH=38;
            const bookBtn={border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FS,fontSize:U(12),letterSpacing:'0.01em',cursor:'pointer',textAlign:'center',background:T.bgIn,whiteSpace:'nowrap',overflow:'hidden',padding:'0 2px',height:bookBtnH,display:'flex',alignItems:'center',justifyContent:'center'};
            const gridBtnActive={...gridBtn,background:T.gF,border:`1px solid ${T.gD}`,color:T.gT};
            const ABBR={'Genesis':'Gen.','Exodus':'Exod.','Leviticus':'Lev.','Numbers':'Num.','Deuteronomy':'Deut.','Joshua':'Josh.','Judges':'Judg.','Ruth':'Ruth','1 Samuel':'1 Sam.','2 Samuel':'2 Sam.','1 Kings':'1 Kgs.','2 Kings':'2 Kgs.','1 Chronicles':'1 Chr.','2 Chronicles':'2 Chr.','Ezra':'Ezra','Nehemiah':'Neh.','Esther':'Esth.','Job':'Job','Psalms':'Ps.','Proverbs':'Prov.','Ecclesiastes':'Eccl.','Song of Solomon':'Song','Isaiah':'Isa.','Jeremiah':'Jer.','Lamentations':'Lam.','Ezekiel':'Ezek.','Daniel':'Dan.','Hosea':'Hos.','Joel':'Joel','Amos':'Amos','Obadiah':'Obad.','Jonah':'Jon.','Micah':'Mic.','Nahum':'Nah.','Habakkuk':'Hab.','Zephaniah':'Zeph.','Haggai':'Hag.','Zechariah':'Zech.','Malachi':'Mal.','Matthew':'Matt.','Mark':'Mark','Luke':'Luke','John':'John','Acts':'Acts','Romans':'Rom.','1 Corinthians':'1 Cor.','2 Corinthians':'2 Cor.','Galatians':'Gal.','Ephesians':'Eph.','Philippians':'Phil.','Colossians':'Col.','1 Thessalonians':'1 Thes.','2 Thessalonians':'2 Thes.','1 Timothy':'1 Tim.','2 Timothy':'2 Tim.','Titus':'Tit.','Philemon':'Phlm.','Hebrews':'Heb.','James':'Jas.','1 Peter':'1 Pet.','2 Peter':'2 Pet.','1 John':'1 Jn.','2 John':'2 Jn.','3 John':'3 Jn.','Jude':'Jude','Revelation':'Rev.'};
            function romanName(name){return ABBR[name]||name;}
            return(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} sheetHeight={navSheetH?navSheetH+'px':undefined}>
              <div ref={navContentRef} style={{overflowX:'hidden',maxWidth:'100%',paddingBottom:12}}>
                {/* Header row and the gold rule under it are pinned together, so the
                    book and chapter stay readable while the list runs on behind
                    them — the rule is the edge it disappears behind. */}
                <div style={{position:'sticky',top:0,zIndex:3,background:T.bgCard,marginBottom:10}}>
                <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  {navStep==='book'?(
                    <button type="button" onClick={closeReadSheet}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  ):navStep==='chapter'?(
                    <button type="button" onClick={()=>{setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);}}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  ):(
                    <button type="button" onClick={()=>{setNavStep('chapter');setNavPickedCh(null);}}
                      style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      ←
                    </button>
                  )}
                  </div>
                  <div style={{textAlign:'center',fontFamily:FS,fontSize:UH(20),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',margin:'0 auto'}}>
                    {navStep==='book'?'Select Book':navStep==='chapter'?bookName(pickedBkData,versionLang(readVid))||'':`${bookName(pickedBkData,versionLang(readVid))||''} ${navPickedCh}`}
                  </div>
                  {navStep==='verse'&&(
                    <div style={{position:'absolute',right:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                      <button type="button" onClick={()=>{if(isP){setParallelVs(1);}if(isC)setCmFocus(null);closeReadSheet();}}
                        style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'6px 10px',cursor:'pointer',fontWeight:600,whiteSpace:'nowrap'}}>
                        Ch {navPickedCh} →
                      </button>
                    </div>
                  )}
                </div>
                <div style={{height:1,background:T.accentLine}}/>
                </div>

                {/* Book grid — two independent scrollable columns */}
                {navStep==='book'&&(
                  <div style={{display:'flex',gap:8,height:`calc(100dvh - ${navH}px - 178px)`,overflow:'hidden'}}>
                    {[{label:'Old Testament',filter:b=>b.n<=39},{label:'New Testament',filter:b=>b.n>=40}].map(({label,filter})=>(
                      <div key={label} style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
                        <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.28em',color:T.gM,textTransform:'uppercase',fontWeight:600,textAlign:'center',marginBottom:6,flexShrink:0,width:'100%',wordSpacing:'0.4em'}}>{label}</div>
                        {/* These columns scroll inside the sheet rather than
                            scrolling it, so they carry their own edges. */}
                        <FadeScroll T={T} className="sheet-scroll" style={{display:'flex',flexDirection:'column',gap:4}}>
                          {BIBLE.filter(filter).map(b=>(
                            <button key={b.n} type="button" onClick={()=>{setNavPickedBk(b.n);setNavPickedCh(null);setNavStep('chapter');}}
                              style={{width:'100%',border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FS,fontSize:UL(13),letterSpacing:'0.03em',cursor:'pointer',textAlign:'center',background:T.bgIn,padding:'9px 4px',boxSizing:'border-box',flexShrink:0}}>
                              {bookName(b,versionLang(readVid))}
                            </button>
                          ))}
                        </FadeScroll>
                      </div>
                    ))}
                  </div>
                )}

                {/* Chapter grid */}
                {navStep==='chapter'&&pickedBkData&&<div>
                  <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.18em',color:T.gM,textTransform:'uppercase',fontWeight:600,marginBottom:5,marginTop:15,textAlign:'center'}}>
                    Select Chapter
                  </div>
                  {/* Scrolls within the sheet like the book columns, so the header
                      above it never moves. Only as tall as it needs to be: a book
                      of one chapter still opens a short sheet. */}
                  <FadeScroll T={T} className="sheet-scroll" fadeKey={navPickedBk}
                    wrapStyle={{flex:'0 1 auto',maxHeight:`calc(100dvh - ${navH}px - 210px)`}}
                    style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:5,alignContent:'start'}}>
                    {Array.from({length:pickedBkData.v.length},(_,i)=>(
                      <button key={i+1} type="button" onClick={()=>{
                        setNavPickedCh(i+1);
                        setNavBk(navPickedBk);setNavCh(i+1);
                        if(isP){setParallelVs(1);}
                        if(isC)setCmFocus(null);
                        setNavStep('verse');
                        setTimeout(()=>{const el=document.querySelector('.slide-down-sheet>div');if(el)el.scrollTop=0;},0);
                      }} style={gridBtn}>{i+1}</button>
                    ))}
                  </FadeScroll>
                </div>}

                {/* Verse grid */}
                {navStep==='verse'&&pickedBkData&&navPickedCh&&<div>
                  <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.18em',color:T.gM,textTransform:'uppercase',fontWeight:600,marginBottom:5,marginTop:15,textAlign:'center'}}>
                    Select Verse
                  </div>
                  <FadeScroll T={T} className="sheet-scroll" fadeKey={navPickedCh}
                    wrapStyle={{flex:'0 1 auto',maxHeight:`calc(100dvh - ${navH}px - 210px)`}}
                    style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:5,alignContent:'start'}}>
                    {Array.from({length:pickedBkData.v[navPickedCh-1]||0},(_,i)=>(
                      <button key={i+1} type="button" onClick={()=>{
                        if(isP){setParallelVs(i+1);}
                        else if(isC){setCmFocus({v:i+1});}
                        else{if(readSearchResultsOpen)setReadSearchResultsOpen(false);setTimeout(()=>{const el=document.getElementById(`rv-${i+1}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(i+1);return ns;});}},120);}
                        closeReadSheet();
                      }} style={gridBtn}>{i+1}</button>
                    ))}
                  </FadeScroll>
                </div>}
              </div>
            </MobileSheet>);
          })()}
          {readMobileSheet==='version'&&(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} sheetHeight={versionSheetH?versionSheetH+'px':undefined}>
              <div ref={versionContentRef} style={{paddingBottom:12}}>
              {versionSheetView==='list'?(
                <>
                  <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                      <button type="button" onClick={closeReadSheet}
                        style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                        ←
                      </button>
                    </div>
                    <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>Select Version</FitTitle>
                  </div>
                  {(data?.versions||[]).map(v=>(
                    <button key={v.id} type="button" className="s-btn s-ghost" onClick={()=>{setReadVid(v.id);closeReadSheet();}}
                      style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',background:readVid===v.id?T.gF:'transparent',border:`1px solid ${readVid===v.id?T.gD:T.bd}`,borderRadius:9,color:readVid===v.id?T.gT:T.mut,fontFamily:FB,fontSize:UH(18),padding:'13px 16px',marginBottom:7}}>
                      <span>{v.label}</span>
                      <span style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',color:readVid===v.id?T.gM:T.dim}}>{v.lang}</span>
                    </button>
                  ))}
                  <div style={{borderTop:`1px solid ${T.bd}`,marginTop:6,paddingTop:12}}>
                    <button type="button" onClick={openManageView}
                      style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,color:T.dim,fontFamily:FB,fontSize:U(14),padding:'10px 14px',cursor:'pointer',boxSizing:'border-box'}}>
                      <span style={{color:T.gM,display:'flex',alignItems:'center'}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span> Manage Bible Versions
                    </button>
                  </div>
                </>
              ):(
                <>
                  <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                      <button type="button" onClick={()=>setVersionSheetView('list')}
                        style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                        ←
                      </button>
                    </div>
                    <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>Bible Versions</FitTitle>
                  </div>
                  {/* Current versions list */}
                  {manageVers.length===0&&<div style={{padding:'18px 0',textAlign:'center',fontFamily:FB,fontSize:U(15),color:T.dim}}>No versions added yet.</div>}
                  {manageVers.map((v,i)=>{
                    const dl=dlStates[v.id]||{};
                    const isBuiltin=PUBLIC_VERSIONS.some(pv=>pv.id===v.id);
                    const avail=mngLocalAvail[v.id];
                    const isReImporting=mngImporting===v.id;
                    return(
                      <div key={v.id} style={{padding:'11px 0',borderBottom:`1px solid ${T.bd}`}}>
                        <div style={{display:'flex',alignItems:'center',gap:12}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontFamily:FB,fontSize:U(16),color:T.body,fontWeight:500}}>{v.label}</div>
                            <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:2,letterSpacing:'0.08em'}}>{isBuiltin?v.id:v.label.toLowerCase()} · {v.lang}{i===0?' · default':''}</div>
                          </div>
                          {isBuiltin&&startDownload&&(
                            dl.downloading?<span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,whiteSpace:'nowrap'}}>{dl.total>0?`${Math.round((dl.progress/dl.total)*100)}%`:'…'}</span>
                            :dl.downloaded?<button onClick={()=>deleteDownload(v.id)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:'#62c484',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>✓ Offline</button>
                            :<button onClick={()=>startDownload(v.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>↓ Offline</button>
                          )}
                          {!isBuiltin&&(
                            isReImporting
                              ?<span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,whiteSpace:'nowrap'}}>{mngImportProg[1]>0?`${Math.round((mngImportProg[0]/mngImportProg[1])*100)}%`:'…'}</span>
                              :avail===true?<span style={{fontFamily:FS,fontSize:UL(9),color:'#62c484',whiteSpace:'nowrap'}}>✓ On device</span>
                              :avail===false?<label style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.07em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                                ⚠︎ Re-import<input type="file" accept=".bblx,.bbli,.SQLite3,.sqlite3,.db" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f)mngDoReImport(v.id,f);e.target.value='';}}/>
                              </label>
                              :null
                          )}
                          <button onClick={()=>manageRemove(v.id)} disabled={manageVers.length===1} style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,padding:'5px 11px',fontSize:U(13),cursor:manageVers.length===1?'default':'pointer',opacity:manageVers.length===1?0.4:1}}>✕</button>
                        </div>
                        {isBuiltin&&dl.downloading&&dl.total>0&&(
                          <div style={{marginTop:6,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${Math.round((dl.progress/dl.total)*100)}%`,background:T.gT,borderRadius:1,transition:'width .2s'}}/>
                          </div>
                        )}
                        {dl.err&&<div style={{fontFamily:FB,fontSize:U(12),color:T.redTxt,marginTop:4}}>{dl.err}</div>}
                      </div>
                    );
                  })}
                  {/* Add built-in versions */}
                  {PUBLIC_VERSIONS.filter(pv=>!manageVers.find(v=>v.id===pv.id)).length>0&&(
                    <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
                      <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>BUILT-IN VERSIONS</div>
                      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                        {PUBLIC_VERSIONS.filter(pv=>!manageVers.find(v=>v.id===pv.id)).map(pv=>(
                          <button key={pv.id} onClick={()=>manageAddBuiltin(pv)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FB,fontSize:U(15),padding:'8px 16px',cursor:'pointer'}}>＋ {pv.label}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Import your own Bible */}
                  <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
                    <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>IMPORT YOUR OWN BIBLE</div>
                    <div style={{fontFamily:FB,fontSize:U(12),color:T.dim,lineHeight:1.6,marginBottom:12}}>Import a Bible you legally own from e-Sword (.bblx) or MyBible (.SQLite3). Text stays on your device only — never uploaded.</div>
                    <input value={mngImportLabel} onChange={e=>setMngImportLabel(e.target.value)} placeholder="Label (e.g. RVR1960)" style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(14),padding:'9px 11px',outline:'none',marginBottom:8}}/>
                    <select value={mngImportLang} onChange={e=>setMngImportLang(e.target.value)} style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(14),padding:'9px 11px',outline:'none',marginBottom:8}}>
                      <option value="EN">English</option>
                      <option value="ES">Spanish</option>
                      <option value="PT">Portuguese</option>
                      <option value="FR">French</option>
                      <option value="DE">German</option>
                      <option value="IT">Italian</option>
                      <option value="ZH">Chinese</option>
                      <option value="AR">Arabic</option>
                      <option value="RU">Russian</option>
                      <option value="OTHER">Other</option>
                    </select>
                    <label style={{display:'block',background:T.bgIn,border:`1px dashed ${T.bd}`,borderRadius:6,padding:'10px 14px',cursor:'pointer',fontFamily:FB,fontSize:U(13),color:mngImportFile?T.body:T.dim,marginBottom:8,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                      {mngImportFile?mngImportFile.name:'Choose .bblx, .bbli, or .SQLite3 file…'}
                      <input type="file" accept=".bblx,.bbli,.SQLite3,.sqlite3,.db" style={{display:'none'}} onChange={e=>{setMngImportFile(e.target.files?.[0]||null);e.target.value='';}}/>
                    </label>
                    {mngImporting==='new'?(
                      <div style={{fontFamily:FB,fontSize:U(13),color:T.gM,padding:'8px 0'}}>
                        Importing…{mngImportProg[1]>0?` ${Math.round((mngImportProg[0]/mngImportProg[1])*100)}%`:''}
                        <div style={{marginTop:6,height:2,background:T.bd,borderRadius:1,overflow:'hidden'}}>
                          <div style={{height:'100%',width:mngImportProg[1]>0?`${Math.round((mngImportProg[0]/mngImportProg[1])*100)}%`:'0%',background:T.gT,borderRadius:1,transition:'width .3s'}}/>
                        </div>
                      </div>
                    ):(
                      <button onClick={mngDoImport} disabled={!mngImportFile||!mngImportLabel.trim()} style={{width:'100%',background:(!mngImportFile||!mngImportLabel.trim())?T.bgIn:T.gF,border:`1px solid ${(!mngImportFile||!mngImportLabel.trim())?T.bd:T.gD}`,borderRadius:6,color:(!mngImportFile||!mngImportLabel.trim())?T.dim:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'10px 0',cursor:(!mngImportFile||!mngImportLabel.trim())?'default':'pointer',fontWeight:600}}>
                        IMPORT
                      </button>
                    )}
                    {mngImportErr&&<div style={{fontFamily:FB,fontSize:U(12),color:T.redTxt,marginTop:6}}>{mngImportErr}</div>}
                    {mngImportNote&&<div style={{fontFamily:FB,fontSize:U(12),color:T.greenTxt,marginTop:6}}>{mngImportNote}</div>}
                  </div>
                  {/* Request a new version */}
                  <div style={{marginTop:20,paddingTop:16}}>
                    <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>REQUEST A VERSION</div>
                    <div style={{fontFamily:FB,fontSize:U(13),color:T.dim,lineHeight:1.7}}>To request a new Bible version or translation to be added to Scriptorium, please contact the app creator.</div>
                  </div>
                  {/* Footer actions */}
                  <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:20,paddingTop:14,borderTop:`1px solid ${T.bd}`}}>
                    <SBtn ch="Cancel" onClick={()=>setVersionSheetView('list')} T={T}/>
                    <PBtn ch="Save" onClick={manageDoSave} T={T}/>
                  </div>
                </>
              )}
              </div>
            </MobileSheet>
          )}

      {/* Fullscreen status-bar mask — always shown when fsActive to hide text scrolling into notch */}
      {fsActive&&(tab==='read'||tab==='commentaries')&&<>
        <div style={{position:'fixed',top:0,left:0,right:0,height:'var(--sat,0px)',background:T.bg,zIndex:190,pointerEvents:'none'}}/>
        {/* Each page pins its own line: Read's chapter rule, or the rule under
            the commentary's heading. */}
        {(tab==='read'?(chLineAbove||readingHidden):cmLineAbove)&&<div style={{position:'fixed',top:'var(--sat,0px)',left:0,right:0,height:1,background:T.accentLine,zIndex:190,pointerEvents:'none'}}/>}
      </>}

      {/* ═══ READ TAB ═══ */}
      {tab==='read'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0}}>

          {/* ═══ THE SEARCH BAR ═══
              Search and its results are one activity, so this is one surface:
              the bar floats over the results it produced. Collapsed it reports
              them; tapping the magnifier expands the field in place and it
              grows a second row so the count stays visible while typing.

              It is fixed to the top, which is what keeps it clear of the
              keyboard — the results scroll underneath. Nothing in this feature
              may be anchored to the bottom. */}
          {searchBarOn&&(()=>{
            const lang=versionLang(readVid);
            const summary=readSearchRes&&readSearchResultsOpen&&!searchShowRecents&&!(searchRef&&readSearchRes.length===0);
            const bookWheelWanted=bookWheelOpen&&searchBooks.length>1&&!!bookLabelBox;
            return (<>
            {/* A sibling of the bar, not a child: the bar's backdrop-filter makes
                it a backdrop root, so a blur nested inside it would filter the
                bar's own content and come out empty. Out here the panel can
                carry the bar's own glass. It needs no measuring — the bar is at
                navH+8 and its height is already tracked, so the two stay
                together when the filters pin and the bar grows a row. */}
            {bookWheelWanted&&(
              <BookWheel key={searchBooks.join('-')} books={searchBooks} value={searchTopBook}
                lang={lang} T={T} onJump={jumpToBook} box={bookLabelBox} onClose={()=>setBookWheelOpen(false)}/>
            )}
            <div ref={searchBarRef} className={"srch-bar-fixed "+(searchClosing?'srch-lift':'srch-drop')} style={{position:'fixed',top:fsActive?'calc(max(var(--sat,0px),var(--sat-min,0px)) + 8px)':navH+8,transition:'top .18s ease',left:14,right:14,zIndex:195, /* under the nav's 200: the bar slides up behind it, not over it */
              display:'flex',flexDirection:'column',gap:6,padding:'7px 10px',
              background:'var(--ac-glass-bg)',border:`1px solid ${T.gD}55`,borderRadius:8,
              backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',
              boxShadow:'0 4px 14px rgba(0,0,0,0.22)'}}>

              <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}>
                {searchFieldOpen?(<>
                  {/* A chevron rather than a glyph: it points down at a menu
                      waiting to open and up at one already open, which is the one
                      thing the old icon never said. */}
                  <button type="button" title="Search options" aria-label="Search options"
                    onClick={()=>setSearchFiltersOpen(o=>!o)}
                    style={{position:'relative',display:'flex',alignItems:'center',justifyContent:'center',width:CTRL,height:CTRL,boxSizing:'border-box',...(searchFiltersOpen||searchOptsDirty?ctrlOnSoft:ctrlRest),borderRadius:6,padding:0,cursor:'pointer',flexShrink:0,transition:'background .12s,border-color .12s,color .12s,box-shadow .12s'}}>
                    <svg width="11" height="7" viewBox="0 0 10 6" style={{transform:searchFiltersOpen?'rotate(180deg)':'none',transition:'transform .2s ease'}}>
                      <path d="M0 0L5 6L10 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    {searchOptsDirty&&<span style={{position:'absolute',top:-2,right:-2,width:6,height:6,borderRadius:3,background:T.gM}}/>}
                  </button>
                  <div style={{position:'relative',flex:1,minWidth:0,display:'flex'}}>
                    {/* 16px or iOS zooms the page on focus */}
                    <input ref={searchInputRef} className="srch-field" value={readSearchQ}
                      onChange={e=>{searchTypedRef.current=true;setReadSearchQ(e.target.value);}}
                      onKeyDown={e=>{
                        if(e.key!=='Enter')return;
                        // Enter means "show me everything", so the capped preview
                        // gives way to the full set and the field gets out of the way.
                        if(refJump)goRefFromBar(refJump);
                        // Blur only: the keyboard has done its job, the field has not.
                        else{doReadSearch();e.currentTarget.blur();}
                      }}
                      placeholder="Search all verses…"
                      style={{flex:1,height:CTRL,boxSizing:'border-box',background:readSearchQ?ctrlOnSoft.background:`${T.g}0d`,border:`1px solid ${T.gD}`,'--srch-bd':readSearchQ?`${T.g}bb`:T.gD,'--srch-bd-on':`${T.g}bb`,'--srch-glow':`${T.g}24`,'--srch-bg-on':T.gF,borderRadius:6,color:T.body,fontFamily:FB,fontSize:16,padding:'0 30px 0 10px',outline:'none',minWidth:0}}/>
                    {readSearchQ&&(
                      <button type="button" title="Clear" aria-label="Clear search"
                        // Clearing the field is not a reason to move focus, and on iOS the
                        // keyboard follows focus: tapping any button blurs the input and the
                        // keyboard drops with it. Refusing the default on the press keeps focus
                        // exactly where it was, so the keyboard stays up if it was up and stays
                        // down if it was down. The click still fires; only the focus change is
                        // prevented. It pairs with not focusing the field afterwards either —
                        // between the two, clearing leaves the keyboard alone in both directions.
                        onMouseDown={e=>e.preventDefault()}
                        onClick={()=>{searchTypedRef.current=false;setReadSearchQ('');}}
                        style={{position:'absolute',right:2,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',outline:'none',color:T.gM,fontSize:U(14),lineHeight:1,cursor:'pointer',padding:'6px 7px',WebkitTapHighlightColor:'transparent'}}>
                        ✕
                      </button>
                    )}
                  </div>
                </>):(<>
                  {searchTopBook&&summary&&topBookLabel(10,'44%')}
                  <div style={{fontFamily:FS,fontSize:UL(9),color:T.mut,letterSpacing:'0.08em',fontWeight:500,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,textAlign:'right'}}>
                    {summary?(<>
                      <span>{readSearchRes.length}{readSearchCapped?'+':''} verse{readSearchRes.length!==1?'s':''}</span>
                      {readSearchOccurrences!==null&&<span> · {readSearchOccurrences} occurrence{readSearchOccurrences!==1?'s':''}</span>}
                    </>):'Search'}
                  </div>
                </>)}
                {/* The magnifier ends the row in both states, so it does not change
                    sides when the field opens. */}
                <button type="button" title="Search" aria-label="Search"
                  onClick={()=>{
                    if(searchFieldOpen){
                      // Same as Enter: the complete set, and the keyboard out of
                      // the way. The field stays, because taking it away is what
                      // made this look like somewhere else.
                      if(refJump)goRefFromBar(refJump);
                      else{doReadSearch();if(searchInputRef.current)searchInputRef.current.blur();}
                      return;
                    }
                    setSearchFieldOpen(true);
                    if(readSearchRes)setReadSearchResultsOpen(true);
                    setTimeout(()=>{const el=searchInputRef.current;if(el){el.focus();el.select();}},40);
                  }}
                  style={{display:'flex',alignItems:'center',justifyContent:'center',width:CTRL,height:CTRL,boxSizing:'border-box',...(searchFlash?ctrlOn:ctrlRest),borderRadius:6,fontSize:UH(19),lineHeight:1,padding:0,cursor:'pointer',flexShrink:0,transition:'background .12s,border-color .12s,color .12s,box-shadow .12s'}}>
                  ⌕
                </button>
              </div>

              {/* Pinned: the filters ride in the bar itself. Nothing to position
                  and nothing to measure separately — the bar is already fixed, and
                  the reading pane already clears whatever height the bar reports. */}
              {searchFiltersPinned&&(
                <div style={{display:'flex',flexDirection:'column',gap:6,paddingTop:1}}>
                  {searchFilterRows()}
                </div>
              )}

              {/* Second row, only while typing: what the query has found so far.
                  The bar's own 6px gap put the book name and the counts right under
                  the field, and the label's negative margin pulled them closer still;
                  this is the air that buys back. The wheel is positioned from the
                  label, so it moves down with it. */}
              {searchFieldOpen&&summary&&(
                <div style={{display:'flex',alignItems:'center',gap:8,minWidth:0,paddingLeft:2,marginTop:4}}>
                  {searchTopBook&&topBookLabel(9.5,'46%')}
                  <div style={{fontFamily:FS,fontSize:UL(9),color:T.mut,letterSpacing:'0.08em',fontWeight:500,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,textAlign:'right'}}>
                    {readSearching?'Searching…':(<>
                      <span>{readSearchRes.length}{readSearchCapped?'+':''} verse{readSearchRes.length!==1?'s':''}</span>
                      {readSearchOccurrences!==null&&<span> · {readSearchOccurrences} occurrence{readSearchOccurrences!==1?'s':''}</span>}
                    </>)}
                  </div>
                </div>
              )}
            </div>
            </>);
          })()}


          {/* Custom overlay scrollbar thumb */}
          <div ref={scrollbarThumbRef} className="read-scrollbar"/>

          {/* Fixed audio overlay button */}
          {audioSource!=='off'&&!readingHidden&&(
            <button type="button" disabled={audioLoading}
              onClick={()=>{
                const packInstalled=readBook<=39?otInstalled:ntInstalled;
                // Only worth mentioning the pack when the pack is what we'd play;
                // it used to interrupt Browser Voice too, and Go to Settings then
                // quietly switched the source back to KJV audio.
                if(readVid==='kjv'&&!packInstalled&&(audioSource==='auto'||audioSource==='local')&&!kjvPromptShownRef.current&&!localStorage.getItem('scrip:audio:kjvPromptDismissed')){kjvPromptShownRef.current=true;setKjvPromptNoShow(false);setShowKjvAudioPrompt(true);return;}
                if(audioPlaying){audioElRef.current?.pause();TTS.pause();setAudioPlaying(false);if(stripOpen)dismissStrip();return;}
                const hasFcbhKey=!!(localStorage.getItem('scrip:audio:fcbhKey')||'').trim();
                const src=audioSrcFor(audioSource==='auto'?(readVid==='kjv'?'local':DEFAULT_FILESETS[readVid]&&hasFcbhKey?'fcbh':'speech'):(audioSource==='off'?null:audioSource));
                if(src==='speech'||audioModeRef.current==='speech'){
                  const hasSelection=readSelVerses.size>0;
                  const sv=hasSelection?Math.min(...readSelVerses):(readVerses[0]?.verse||1);
                  if(audioLoaded&&TTS.paused&&!hasSelection){TTS.resume();setAudioPlaying(true);}
                  else if(audioLoaded){doStartSpeech(sv);}
                  else{loadChapterAudio('speech');}
                  return;
                }
                (audioLoaded&&(audioModeRef.current==='fcbh'||audioModeRef.current==='local'))?handlePlayPause():loadChapterAudio();
              }}
              style={{position:'fixed',top:readFullScreen.current?Math.max(4,navH-44):Math.max(8,navH+8),right:14,zIndex:140,display:'flex',alignItems:'center',gap:0,padding:(audioPlaying||audioLoading||audioLoaded)?'7px 12px':'7px 9px',background:'var(--ac-glass-bg)',border:`1px solid ${T.gD}55`,outline:'none',WebkitTapHighlightColor:'transparent',borderRadius:6,color:audioPlaying||audioLoaded?T.gT:T.dim,cursor:audioLoading?'wait':'pointer',fontFamily:FB,fontSize:U(12),transition:'all .22s ease',backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',flexShrink:0,overflow:'hidden',boxShadow:'0 4px 14px rgba(0,0,0,0.22)',opacity:1}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'center',width:16,height:16,flexShrink:0}}>
                {audioLoading
                  ?<Spinner/>
                  :audioPlaying
                    ?<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    :<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                }
              </div>
              <span style={{maxWidth:(audioPlaying||audioLoading||audioLoaded)?160:0,opacity:(audioPlaying||audioLoading||audioLoaded)?1:0,overflow:'hidden',whiteSpace:'nowrap',transition:'max-width .22s ease, opacity .18s ease, margin .22s ease',marginLeft:(audioPlaying||audioLoading||audioLoaded)?8:0,fontWeight:600,letterSpacing:'0.06em'}}>
                {audioLoading?'Loading…':!audioPlaying&&audioLoaded?(readSelVerses.size>0?`Play from Verse ${Math.min(...readSelVerses)}`:`Resume · Verse ${currentVerse||1}`):(currentVerse?`Verse ${currentVerse}`:'Ready')}
              </span>
            </button>
          )}

          {/* KJV audio prompt */}
          {showKjvAudioPrompt&&(
            <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:300,padding:24}}>
              <div style={{background:T.bgCard,border:`1px solid ${T.bdA}`,borderRadius:14,width:'min(92vw,380px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.7)'}}>
                <div style={{height:3,background:T.accentLine}}/>
                <div style={{padding:'24px 28px'}}>
                  <div style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:14,textAlign:'center'}}>KJV Audio</div>
                  <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,lineHeight:1.7,marginBottom:20}}>
                    Currently using your device's built-in voice. For a professional audio Bible reading, download the free KJV MP3 pack in <span style={{color:T.gT,fontWeight:500}}>Settings → Audio Playback → KJV Audio</span>.
                  </div>
                  <label style={{display:'flex',alignItems:'center',gap:10,marginBottom:20,cursor:'pointer'}}>
                    <input type="checkbox" checked={kjvPromptNoShow} onChange={e=>setKjvPromptNoShow(e.target.checked)} style={{width:16,height:16,accentColor:T.g,cursor:'pointer'}}/>
                    <span style={{fontFamily:FB,fontSize:U(13),color:T.dim}}>Don't show this again</span>
                  </label>
                  <div style={{display:'flex',gap:10}}>
                    <button type="button" onClick={()=>{if(kjvPromptNoShow)localStorage.setItem('scrip:audio:kjvPromptDismissed','true');setShowKjvAudioPrompt(false);setAudioSource('local');try{localStorage.setItem('scrip:audio:source','local');}catch{}setAudioSettingsOpen(true);setReadMobileSheet('settings');}}
                      style={{flex:1,background:'none',border:`1px solid ${T.bd}`,borderRadius:8,color:T.gM,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'10px 0',cursor:'pointer'}}>
                      Go to Settings
                    </button>
                    <button type="button" onClick={()=>{if(kjvPromptNoShow)localStorage.setItem('scrip:audio:kjvPromptDismissed','true');setShowKjvAudioPrompt(false);const sv=readSelVerses.size>0?Math.min(...readSelVerses):(readVerses[0]?.verse||1);doStartSpeech(sv);}}
                      style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',fontWeight:600,padding:'10px 0',cursor:'pointer'}}>
                      Play Anyway
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Verse content */}

          <div ref={readRef} className={"read-area"+(readingHidden?' bar-away':'')} style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',padding:`${navH+(searchBarH?searchBarH+18:8)}px 5px 64px`,maxWidth:960,margin:'0 auto',width:'100%',boxSizing:'border-box'}}
            onTouchStart={e=>{
              // The chapter is not on screen while search owns it, so a sideways
              // swipe here would move it with nothing to show for it.
              if(readingHidden){swipeTouchX.current=null;return;}
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
          {!readingHidden&&(
            <div style={{padding:'10px 12px 2px'}}>
              <div style={{textAlign:'center',fontFamily:FS,fontSize:UL(9),letterSpacing:'0.28em',textTransform:'uppercase',color:T.gM,marginBottom:2,fontWeight:500}}>{readVerLabel}</div>
              <div style={{position:'relative',display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{fontFamily:FS,fontSize:UH(19),fontWeight:600,color:T.gT,letterSpacing:'0.06em',textAlign:'center'}}>{bookName(readBk,versionLang(readVid))} {readCh}</div>
              </div>
              <div ref={chLineRef} style={{height:1,background:T.accentLine,marginTop:8}}/>
            </div>
          )}
            {/* Unpinned, the filters belong to the opening page only, beside the
                recent searches. Pinned, they ride in the bar instead. */}
            {searchFiltersInFlow&&(
              <div className={searchClosing?'srch-body-out':'srch-body-in'} style={{padding:'2px 10px 12px',display:'flex',flexDirection:'column',gap:7}}>
                {searchFilterRows()}
              </div>
            )}
            {/* Nothing to search for yet: offer what was searched before. */}
            {searchShowRecents&&(
              <div className={searchClosing?'srch-body-out':'srch-body-in'} style={{padding:'6px 10px'}}>
                {recentSearches.length>0?(<>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                    <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',fontWeight:600}}>Recent Searches</div>
                    <button type="button" onClick={()=>{setRecentSearches([]);try{localStorage.removeItem('scrip_recent_searches');}catch{}}}
                      style={{background:'none',border:'none',color:T.dim,fontFamily:FS,fontSize:UL(8),letterSpacing:'0.1em',textTransform:'uppercase',cursor:'pointer',padding:0}}>Clear</button>
                  </div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:7}}>
                    {recentSearches.map(r=>(
                      <button key={r} type="button" onClick={()=>{searchTypedRef.current=false;doReadSearch(r);}}
                        style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.mut,fontFamily:FB,fontSize:U(13),padding:'6px 13px',cursor:'pointer'}}>
                        {r}
                      </button>
                    ))}
                  </div>
                </>):(
                  <div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(14),padding:'10px 2px'}}>
                    Type at least three characters to search this version.
                  </div>
                )}
                {searchRef&&(
                  <button type="button" onClick={()=>goRefFromBar(searchRef)}
                    style={{display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,padding:'11px 12px',marginTop:12,cursor:'pointer'}}>
                    <span style={{fontSize:U(15),color:T.gT,flexShrink:0}}>⤷</span>
                    <span style={{fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',flexShrink:0}}>Go to</span>
                    <span style={{fontFamily:FS,fontSize:U(14),color:T.gT,letterSpacing:'0.06em',fontWeight:600}}>
                      {bookName(searchRef.book,versionLang(readVid))} {searchRef.chapter}{searchRef.verse?`:${searchRef.verse}`:''}
                    </span>
                  </button>
                )}
              </div>
            )}
            {/* The query is long enough to search but nothing has come back
                yet. Something has to hold the space, or the screen goes blank
                between keystrokes. */}
            {searchFieldOpen&&!searchShowRecents&&!(readSearchRes&&readSearchResultsOpen)&&(
              <div className={searchClosing?'srch-body-out':'srch-body-in'} style={{padding:'22px 12px',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(14),textAlign:'center'}}>
                Searching…
              </div>
            )}
            {!searchShowRecents&&readSearchRes&&readSearchResultsOpen&&(
              <div className={searchClosing?'srch-body-out':'srch-body-in'}>
                {/* A typed reference beats searching for its own text. */}
                {searchRef&&(
                  <button type="button" onClick={()=>goRefFromBar(searchRef)}
                    style={{display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,padding:'11px 12px',marginBottom:10,cursor:'pointer'}}>
                    <span style={{fontSize:U(15),color:T.gT,flexShrink:0}}>⤷</span>
                    <span style={{fontFamily:FS,fontSize:UL(8.5),letterSpacing:'0.14em',color:T.gM,textTransform:'uppercase',flexShrink:0}}>Go to</span>
                    <span style={{fontFamily:FS,fontSize:U(14),color:T.gT,letterSpacing:'0.06em',fontWeight:600}}>
                      {bookName(searchRef.book,versionLang(readVid))} {searchRef.chapter}{searchRef.verse?`:${searchRef.verse}`:''}
                    </span>
                  </button>
                )}
                {readSearchRes.length===0&&!searchRef&&(
                  <div>
                    <div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(15),marginBottom:10}}>No verses found.</div>
                    {searchOpts.caseSensitive&&(
                      <div style={{fontSize:U(12),marginBottom:6,padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠︎ Case Sensitive is on — "{readSearchQ}" must match exact case.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,caseSensitive:false};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:U(12),padding:0,fontFamily:FB}}>Disable it →</button>
                      </div>
                    )}
                    {searchOpts.partial===false&&(
                      <div style={{fontSize:U(12),marginBottom:6,padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠︎ Whole Word mode — partial matches excluded.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,partial:true};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:U(12),padding:0,fontFamily:FB}}>Enable Partial Match →</button>
                      </div>
                    )}
                    {searchOpts.scope!=='all'&&(
                      <div style={{fontSize:U(12),padding:'5px 9px',borderRadius:5,background:'rgba(210,60,60,0.08)',border:'1px solid rgba(210,60,60,0.22)',color:dark?'#e08888':'#bf4040',fontFamily:FB}}>
                        ⚠︎ Scope: {searchOpts.scope==='ot'?'OT Only':'NT Only'} — results limited.{' '}
                        <button type="button" onClick={()=>{const o={...searchOpts,scope:'all'};setSearchOpts(o);doReadSearch(undefined,o);}} style={{background:'none',border:'none',color:'inherit',textDecoration:'underline',cursor:'pointer',fontSize:U(12),padding:0,fontFamily:FB}}>Search All Scripture →</button>
                      </div>
                    )}
                  </div>
                )}
                {(()=>{let lastBk=null;return readSearchRes.slice(0,readSearchLimit).map(r=>{const b=BIBLE.find(x=>x.n===r.book_num);const firstOfBook=r.book_num!==lastBk;if(firstOfBook)lastBk=r.book_num;return(
                  <div key={`${r.book_num}-${r.chapter}-${r.verse}`} id={firstOfBook?`srch-bk-${r.book_num}`:undefined} className="reading-verse s-btn" onClick={()=>{if(readRef.current)searchResultScrollRef.current=readRef.current.scrollTop;searchTypedRef.current=false;abandonSearch();setSearchFieldOpen(false);setSearchFiltersOpen(false);setReadSearchResultsOpen(false);const sameChap=(r.book_num===readBook&&r.chapter===readCh);landSilent.current=true;if(sameChap){setTimeout(()=>{const el=document.getElementById(`rv-${r.verse}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(new Set([r.verse]));setStripOpen(false);landSilent.current=false;autoSel.current=true;},50);}else{readScrollToVerse.current=r.verse;setReadBook(r.book_num);setReadCh(r.chapter);}}} style={{padding:'10px 12px',marginBottom:6,borderRadius:6,border:`1px solid ${T.bd}`,background:T.bgCard,cursor:'pointer'}}>
                    <div style={{fontFamily:FS,fontSize:UL(10),color:T.gM,marginBottom:4,letterSpacing:'0.08em',fontWeight:500}}>{bookName(b,versionLang(readVid))} {r.chapter}:{r.verse}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textAlign:readTextAlign}} dangerouslySetInnerHTML={{__html:hl(r.text,readSearchQ,searchOpts)}}/>
                  </div>
                );});})()}
                {readSearchLimit<readSearchRes.length&&(
                  <div style={{textAlign:'center',padding:'14px 0',color:T.dim,fontFamily:FS,fontSize:UL(8),letterSpacing:'0.12em'}}>
                    ··· {readSearchRes.length-readSearchLimit} more ···
                  </div>
                )}
              </div>
            )}
            {!readingHidden&&readVerses.length===0&&(
              <div style={{textAlign:'center',padding:'48px 0',color:T.dim,fontFamily:FB,fontStyle:'italic',fontSize:U(15)}}>
                No verses found. Download a version for offline use via the Compare tab &gt; Versions.
              </div>
            )}
            {strongsMode&&readVid!=='kjv'&&!readingHidden&&(
              <div style={{margin:'8px 8px 0',padding:'8px 14px',borderRadius:7,border:`1px solid ${T.gD}`,background:T.gF,display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:T.gT,fontSize:U(14),flexShrink:0}}>ℍ</span>
                <span style={{fontFamily:FB,fontSize:U(13),color:T.gM,lineHeight:1.4}}>Strong's mode is only available for KJV.</span>
              </div>
            )}
            {!readingHidden&&readVerses.length>0&&(
              readParaMode?(
                <div style={{textAlign:readTextAlign,padding:'3px 4px'}}>
                  {readVerses.map(({verse:v,text})=>{
                    const sel=!audioPlaying&&readSelVerses.has(v);
                    const isAudio=audioPlaying&&currentVerse===v;
                    return(
                      <span key={v} data-verse={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={verseTouchEnd}
                        onClick={()=>{if(audioPlaying){if(audioModeRef.current==='speech'){seekWebSpeechToVerse(v);}else{const _ts=audioTimestampsRef.current;if(_ts&&_ts[v]!==undefined&&audioElRef.current){audioElRef.current.currentTime=_ts[v];currentVerseRef.current=v;setCurrentVerse(v);}}}else{verseClick(v);}}}
                        style={{cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',background:isAudio?'var(--ac-audio-bg)':sel?T.gF:'transparent',borderRadius:isAudio?4:sel?Math.round(readFontSize*0.15):0,padding:sel?`${Math.round(readFontSize*0.08)}px ${Math.round(readFontSize*0.1)}px`:0,boxShadow:sel?`0 0 0 ${Math.max(1,Math.round(readFontSize*0.04))}px ${T.gD}`:'none',transition:'all .2s'}}>
                        {readVerseNums==='super'&&<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:sel?T.gT:T.gM,marginRight:2,fontWeight:600}}>{v}</sup>}
                        {readVerseNums==='inline'&&<span style={{fontFamily:FS,fontSize:UL(10),color:sel?T.gT:T.gM,marginRight:6,fontWeight:600}}>{v}</span>}
                        <span className="rv-text" style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textDecoration:isAudio&&readParaMode?'underline':'none',textDecorationColor:isAudio?'var(--ac-audio-line)':'transparent',...hlStyle(v)}}>
                          {strongsMode&&strongsData[v]?buildStrongsVerse(wojWrap(readBook,readCh,v,text),strongsData[v],handleStrongsWordTap,T,dark,readRedLetter):<span dangerouslySetInnerHTML={{__html:processRedLetter(wojWrap(readBook,readCh,v,text),readRedLetter,dark)}}/>}
                        </span>
                        {' '}
                      </span>
                    );
                  })}
                </div>
              ):(
                <div style={{textAlign:readTextAlign,padding:'3px 4px'}}>
                  {readVerses.map(({verse:v,text})=>{
                    const sel=!audioPlaying&&readSelVerses.has(v);
                    const isAudio=audioPlaying&&currentVerse===v;
                    return(
                      <div key={v} data-verse={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={verseTouchEnd}
                        onClick={()=>{if(audioPlaying){if(audioModeRef.current==='speech'){seekWebSpeechToVerse(v);}else{const _ts=audioTimestampsRef.current;if(_ts&&_ts[v]!==undefined&&audioElRef.current){audioElRef.current.currentTime=_ts[v];currentVerseRef.current=v;setCurrentVerse(v);}}}else{verseClick(v);}}}
                        style={{padding:'2px 4px',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',borderRadius:5,background:isAudio?'var(--ac-audio-bg)':sel?T.gF:'transparent',boxShadow:isAudio?`0 0 0 1.5px var(--ac-audio-ring)`:sel?`0 0 0 1.5px ${T.gD}, 0 1px 6px var(--ac-sel-glow)`:'none',marginBottom:1,transition:'all .2s'}}>
                        {readVerseNums==='super'&&<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:sel?T.gT:T.gM,marginRight:2,userSelect:'none',fontWeight:600}}>{v}</sup>}
                        {readVerseNums==='inline'&&<span style={{fontFamily:FS,fontSize:UL(10),color:sel?T.gT:T.gM,marginRight:6,userSelect:'none',fontWeight:600}}>{v}</span>}
                        <span className="rv-text" style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,...hlStyle(v)}}>
                          {strongsMode&&strongsData[v]?buildStrongsVerse(wojWrap(readBook,readCh,v,text),strongsData[v],handleStrongsWordTap,T,dark,readRedLetter):<span dangerouslySetInnerHTML={{__html:processRedLetter(wojWrap(readBook,readCh,v,text),readRedLetter,dark)}}/>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
            {!readingHidden&&readVerses.length>0&&(
              <div style={{paddingTop:20,paddingBottom:stripOpen&&!stripClosing?130:69,textAlign:'center',transition:'padding-bottom .18s ease'}}>
                <div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.22em',textTransform:'uppercase',color:T.gD,fontWeight:500}}>
                  {readCh===readTotalCh?'End of Book':'End of Chapter'}
                </div>
              </div>
            )}
          </div>

          {/* Strong's popup */}
          {strongsPopup&&(()=>{
            // Parse derivation text for H/G number links
            function renderDerivation(text){
              if(!text)return null;
              const parts=[];let last=0;
              const re=/([HG]\d+)/g;let m;
              while((m=re.exec(text))!==null){
                if(m.index>last)parts.push(text.slice(last,m.index));
                const raw=m[1],num=normStrongsNum(raw);
                parts.push(React.createElement('span',{key:m.index,onClick:e=>{e.stopPropagation();loadStrongsEntry(num);},style:{color:T.gT,cursor:'pointer',fontWeight:600,textDecoration:'underline dotted'}},num));
                last=m.index+raw.length;
              }
              if(last<text.length)parts.push(text.slice(last));
              return parts;
            }
            // Group verses by word_text, deduplicate verse refs
            const verses=strongsPopup.verses||[];
            const groups={};
            for(const r of verses){
              const key=(r.word_text||'').toLowerCase();
              if(!groups[key])groups[key]={word:r.word_text,refs:new Map()};
              const refKey=`${r.book_num}|${r.chapter}|${r.verse}`;
              groups[key].refs.set(refKey,r.verse_count||1);
            }
            const _FUNC=new Set(['the','a','an','in','of','from','without','upon','unto','to','for','by','with','at','into','on','and','or','but','nor','so','yet','it','its','he','she','we','they','his','her','their','our','my','thy','thine','mine','ye','thou','thee','him','them','me','us','this','that','these','those','who','whom','whose','which','what','there','here','then','when','where','not','no','as','if','though']);
            const groupList=Object.entries(groups).filter(([k])=>!_FUNC.has(k)).sort((a,b)=>[...b[1].refs.values()].reduce((s,c)=>s+c,0)-[...a[1].refs.values()].reduce((s,c)=>s+c,0));
            const totalCount=verses[0]?.total_count??new Set(verses.map(r=>`${r.book_num}|${r.chapter}|${r.verse}`)).size;

            // Above the bottom bar (150), which stays put and is simply covered.
            return React.createElement('div',{onClick:closeStrongsPopup,style:{position:'fixed',inset:0,zIndex:160,background:'rgba(0,0,0,0.2)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'stretch',justifyContent:'center',paddingTop:navH+100,paddingBottom:0,boxSizing:'border-box',animation:strongsClosing?'backdropOut .26s ease both':'backdropIn .15s ease both'}},
              React.createElement('div',{onClick:e=>e.stopPropagation(),style:{position:'relative',background:T.bg,borderRadius:'16px 16px 0 0',borderTop:`2px solid ${T.bdA}`,width:'100%',maxWidth:520,minHeight:260,overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 8px 48px rgba(0,0,0,0.5)',willChange:'transform',
                animation:strongsDragMode?'none':(strongsClosing?'sheetClose .26s cubic-bezier(0.4,0,1,1) both':'sheetOpen .38s cubic-bezier(0.22,1,0.36,1) both')},ref:strongsPanelRef},
              React.createElement('div',{style:{height:3,background:T.accentLine,flexShrink:0}}),
              // Floated over the top of the content rather than placed above it, so
              // it takes no height and leaves no band of its own — only the pill
              // shows, sitting in padding the header already had.
              React.createElement('div',{...strongsDragHandlers,
                style:{position:'absolute',top:0,left:0,right:0,zIndex:2,display:'flex',justifyContent:'center',alignItems:'flex-start',height:22,paddingTop:10,boxSizing:'border-box',touchAction:'none',cursor:'grab'}},
                React.createElement('div',{style:{width:36,height:4,background:T.bdA,borderRadius:2}})),
              // Pinned to the panel rather than carried inside the scroller: a
              // long entry used to take the close button up out of sight with it,
              // so getting out meant scrolling all the way back first. A sibling
              // of the scrolling area stays put however far the text runs. It sits
              // where it always did — the scroller's own 20px padding — so nothing
              // appears to have moved.
              //
              // Same shape as the verse strip's close: 32 by 30, the muted red,
              // the thin red edge. They do the same job in the same app and were
              // two different buttons.
              React.createElement('button',{type:'button',onClick:closeStrongsPopup,title:'Close','aria-label':'Close',
                style:{position:'absolute',top:22,right:20,zIndex:3,background:'var(--ac-glass-bg)',border:'1px solid rgba(200,60,60,0.35)',backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',boxShadow:'0 4px 14px rgba(0,0,0,0.22)',borderRadius:6,color:'#b86060',cursor:'pointer',fontSize:U(13),fontWeight:600,width:32,height:30,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,boxSizing:'border-box',padding:0}},'\u2715'),
              React.createElement('div',{style:{overflow:'auto',padding:'20px 20px calc(32px + env(safe-area-inset-bottom))',flex:1,display:'flex',flexDirection:'column',minHeight:0}},
                React.createElement(StrongsEntry,{T,num:strongsPopup.strongs_number,entry:strongsPopup.entry,groupList,totalCount,
                  expanded:strongsExpandedWords,onToggle:key=>setStrongsExpandedWords(s=>{const ns=new Set(s);ns.has(key)?ns.delete(key):ns.add(key);return ns;}),
                  onRef:(bn,ch,vs)=>openStrongsVersePreview(bn,ch,vs),
                  derivation:strongsPopup.entry?.full_def?renderDerivation(strongsPopup.entry.full_def):null,
                  readFont:{family:fontFamilyMap[readFontFamily],size:readFontSize},lang:versionLang(readVid),reserveRight:44,
                  lead:(strongsPopup.history||[]).length>0&&React.createElement(NavIconBtn,{ch:'‹',label:'Back',T,title:'Back',size:34,onClick:e=>{e.stopPropagation();goBackStrongs();}})}),
                strongsPopup.entry&&(
                  React.createElement('div',null,
                    groupList.length===0&&strongsPopup.versesLoading&&React.createElement('div',{style:{fontFamily:FB,fontSize:U(13),color:T.dim,paddingTop:8}},'Loading verses…'),
                    groupList.length===0&&!strongsPopup.versesLoading&&strongsPopup.versesOffline&&React.createElement('div',{style:{fontFamily:FB,fontSize:U(13),color:T.dim,paddingTop:8,lineHeight:1.5}},'KJV occurrences need a connection. The definition above is saved on your device.'),
                    React.createElement('div',{style:{textAlign:'center',paddingTop:24,paddingBottom:8,borderTop:`1px solid ${T.bd}`,marginTop:16}},
                      React.createElement('div',{style:{fontSize:UH(24),color:T.gM,marginBottom:6}},'·'),
                      React.createElement('div',{style:{fontFamily:FB,fontSize:U(11),color:T.dim,letterSpacing:'0.06em'}},'End of entry')
                    )
                  )
                )
              )
            )
          );
          })()}

          {/* Selection action strip */}
          {/* The day's readings, floating in the same slot the verse strip uses
              and wearing the same glass. It stands down while that strip is up:
              one thing at a time down there, and the strip is the one you just
              asked for. Session-lived, cleared by its own cross. */}
          {/* The day, shaped like its row in the plan: one checkbox, then the
              passages. The checkbox is the plan's own -- ticking here ticks there.
              Each piece wears the verse strip's glass and floats on its own, and
              the row stacks above that strip rather than giving way to it. */}
          {planStrip&&tab==='read'&&!readingHidden&&(()=>{
            const base=fsActive?Math.max(0,bottomBarH-50):Math.max(0,bottomBarH+8);
            const dayDone=new Set(planState.done).has(planStrip.day);
            const glass={...floatFace,
              height:30,boxSizing:'border-box',flexShrink:0};
            return (
            <div ref={planStripRef} style={{position:'fixed',bottom:base+(stripOpen&&!audioPlaying?verseStripH+8:0),left:14,right:14,zIndex:134,
              display:'flex',flexWrap:'wrap',justifyContent:'center',alignItems:'center',gap:8,pointerEvents:'none',
              transition:'bottom .18s ease'}}>
              <button type="button" onClick={()=>planToggleDay(planStrip.day)}
                aria-label={dayDone?'Mark day as not read':'Mark day as read'}
                style={{...glass,pointerEvents:'auto',width:32,display:'flex',alignItems:'center',justifyContent:'center',
                  ...(dayDone?floatOn:{}),
                  color:dayDone?T.gT:`${T.dim}99`,fontSize:U(14),lineHeight:1,padding:0,cursor:'pointer'}}>✓</button>
              {planStrip.items.map((it,i)=>{
                const here=readBook===it.b&&readCh>=it.c&&readCh<=it.c2;
                return (
                  <button key={i} type="button" onClick={()=>openPlanPassage(it.b,it.c,it.v,planStrip.day)}
                    style={{...glass,...(here?floatOn:{}),pointerEvents:'auto',padding:'0 12px',
                      fontFamily:FB,fontSize:U(13),letterSpacing:'0.06em',fontWeight:600,whiteSpace:'nowrap',cursor:'pointer',
                      color:dayDone?T.dim:(here?T.gT:floatText),textDecoration:dayDone?'line-through':'none'}}>{it.short}</button>
                );
              })}
              <button type="button" aria-label="Hide the day's readings" onClick={()=>setPlanStrip(null)}
                style={{...glass,pointerEvents:'auto',width:32,display:'flex',alignItems:'center',justifyContent:'center',
                  border:'1px solid rgba(200,60,60,0.35)',color:'#b86060',fontSize:U(14),fontWeight:600,
                  lineHeight:1,padding:0,cursor:'pointer'}}>✕</button>
            </div>);
          })()}
          {stripOpen&&tab==='read'&&!readingHidden&&!audioPlaying&&(
            <div ref={verseStripRef} className={stripClosing?'slide-down-strip':'slide-up-strip'} style={{position:'fixed',bottom:fsActive?Math.max(0,bottomBarH-50):Math.max(0,bottomBarH+8),left:14,right:14,zIndex:135,padding:'7px 0',display:'flex',alignItems:'center',height:'auto',minHeight:44,boxSizing:'border-box',transition:'bottom .18s ease'}}>
              {readBmOk
                ?<span style={{fontFamily:FS,fontSize:U(14),letterSpacing:'0.12em',color:'#62c484',fontWeight:600,flex:1,textAlign:'center'}}>✓ Bookmarked</span>
                :readCopyOk
                  ?<span style={{fontFamily:FS,fontSize:U(14),letterSpacing:'0.12em',color:'#62c484',fontWeight:600,flex:1,textAlign:'center'}}>✓ Copied</span>
                  :<div style={{display:'flex',flexDirection:'column',gap:6,width:'100%'}}>
                    {/* The colours, above the bar, while the highlight button is open. */}
                    {hlPickerOpen&&user&&(
                      <div style={{...floatFace,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'space-between',gap:6,padding:'7px 10px'}}>
                        {HL_COLORS.map(c=>(
                          <button key={c.key} type="button" aria-label={`Highlight ${c.label.toLowerCase()}`} onClick={()=>applyHighlight(c.key)}
                            style={{width:U(28),height:U(28),borderRadius:'50%',background:c.dot,border:`2px solid ${selHL===c.key?T.gT:'transparent'}`,padding:0,cursor:'pointer',flexShrink:0,boxSizing:'border-box'}}/>
                        ))}
                        <button type="button" onClick={()=>applyHighlight(null)}
                          style={{background:'none',border:'none',fontFamily:FB,fontSize:U(13),fontWeight:600,letterSpacing:'0.06em',color:anyHL?floatText:T.dim,cursor:'pointer',padding:'0 2px'}}>Remove</button>
                      </div>
                    )}
                    {/* Row 1: verse badge, then the buttons as one group. The row wraps:
                        when a long selection's reference leaves no room beside it, the
                        whole group drops beneath the reference together, rather than
                        the ✕ being pushed off the screen. A reference longer than the
                        bar wraps inside its own box. */}
                    <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:6}}>
                      <span style={{fontFamily:FB,fontSize:U(13),color:T.gT,letterSpacing:'0.08em',fontWeight:600,flex:'0 1 auto',maxWidth:'100%',...floatFace,borderRadius:6,padding:'5px 10px',minHeight:30,lineHeight:1.3,overflowWrap:'anywhere',boxSizing:'border-box',display:'flex',alignItems:'center',whiteSpace:'normal'}}>
                        {(()=>{const a=[...readSelVerses].sort((a,b)=>a-b);const r=[];let i=0;while(i<a.length){let j=i;while(j+1<a.length&&a[j+1]===a[j]+1)j++;r.push(j>i?`${a[i]}-${a[j]}`:String(a[i]));i=j+1;}return `${shortBook(bookName(readBk,versionLang(readVid)))} ${readCh}:${r.join(', ')}`;})()}
                      </span>
                      <div style={{display:'flex',alignItems:'center',gap:6,flex:'1 1 auto'}}>
                      {/* Compact: a colour dot, not a word. It shows the selection's colour
                          when every selected verse shares one, and all five when not. */}
                      {user&&(
                        <button type="button" aria-label="Highlight" aria-expanded={hlPickerOpen} onClick={()=>setHlPickerOpen(o=>!o)}
                          style={{...floatFace,...(hlPickerOpen?{border:`1px solid ${T.gM}`}:{}),borderRadius:6,flexShrink:0,width:34,height:30,boxSizing:'border-box',padding:0,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>
                          <span style={{width:U(14),height:U(14),borderRadius:'50%',display:'block',background:selHL?hlByKey[selHL].dot:'conic-gradient(#e4c448 0 20%,#62c484 0 40%,#6aaaeb 0 60%,#aa82dc 0 80%,#eb9650 0)',opacity:selHL?1:0.8}}/>
                        </button>
                      )}
                      {user
                        ?<button type="button" onClick={()=>doReadBookmark()}
                          style={{flex:1,...floatFace,borderRadius:6,color:floatText,fontFamily:FB,fontSize:U(13),letterSpacing:'0.06em',padding:'0 4px',whiteSpace:'nowrap',fontWeight:600,cursor:'pointer',height:30,boxSizing:'border-box',transition:'color .15s',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                          <span>Bookmark</span>
                        </button>
                        :<span style={{flex:1,fontFamily:FB,fontStyle:'italic',color:T.gM,fontSize:U(13),textAlign:'center'}}>Sign in to bookmark</span>}
                      <button type="button" onClick={()=>copySelectedVerses()}
                        style={{flex:1,...floatFace,borderRadius:6,color:floatText,fontFamily:FB,fontSize:U(13),letterSpacing:'0.06em',padding:'0 4px',whiteSpace:'nowrap',fontWeight:600,height:30,boxSizing:'border-box',transition:'color .15s',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                        <span>Copy</span>
                      </button>
                      <button type="button" onClick={dismissStrip}
                        style={{background:'var(--ac-glass-bg)',border:'1px solid rgba(200,60,60,0.35)',backdropFilter:'blur(7px)',WebkitBackdropFilter:'blur(7px)',boxShadow:'0 4px 14px rgba(0,0,0,0.22)',borderRadius:6,color:'#b86060',cursor:'pointer',fontSize:U(14),fontWeight:600,flexShrink:0,width:32,height:30,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,boxSizing:'border-box',transition:'color .15s',padding:0}}>✕</button>
                      </div>
                    </div>
                  </div>
              }
            </div>
          )}

          {/* Bottom nav */}
          {/* Search owns the screen, so the chapter bar leaves it. Sliding on a
              transform rather than unmounting: the compositor does the move, and
              offsetHeight stays what it was for the three places that measure
              this bar to lay other things out. pointer-events goes with it, so
              the buttons cannot be hit through the gap on the way past or once
              it has gone — which is the half of this that is not decoration:
              tapping a chapter arrow from the results took you somewhere else
              entirely. */}
          <div ref={bottomBarRef} style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,
            transform:readingHidden?'translateY(100%)':'none',pointerEvents:readingHidden?'none':'auto',
            transition:'transform .22s cubic-bezier(0.32,0.72,0,1)'}}>
            <div className="bottom-nav-safe" style={{padding:'5px 12px 0 12px',display:'flex',justifyContent:'space-between',alignItems:'center',minHeight:49,boxSizing:'border-box'}}>
              <button type="button" className="s-btn s-ghost" onClick={readPrevCh} style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',fontWeight:500,width:UL(90),minHeight:U(34),overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {'\u2039'} {readCh>1?`Ch ${readCh-1}`:readBook>1?bookName(BIBLE.find(b=>b.n===readBook-1),versionLang(readVid)):''}
              </button>
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                <span style={{fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',color:T.dim,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',textTransform:'uppercase'}}>
                  {bookName(BIBLE.find(b=>b.n===readBook),versionLang(readVid))||''} {readCh}
                </span>
              </div>
              <button type="button" className="s-btn s-ghost" onClick={readNextCh} style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',fontWeight:500,width:UL(90),minHeight:U(34),overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {readCh<readTotalCh?`Ch ${readCh+1}`:readBook<66?bookName(BIBLE.find(b=>b.n===readBook+1),versionLang(readVid)):''} {'\u203a'}
              </button>
            </div>
            {/* Drawn over the bar's safe-area strip rather than added to it, so
                going offline never shifts the nav buttons. */}
            {!online&&(
              <div style={{position:'absolute',left:0,right:0,bottom:'max(2px, calc(env(safe-area-inset-bottom, 0px) / 2 - 5px))',display:'flex',justifyContent:'center',pointerEvents:'none'}}>
                <span style={{fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.14em',textTransform:'uppercase',color:T.ambTxt}}>Offline</span>
              </div>
            )}
            </div>
        </div>
      )}

      {/* ═══ PARALLEL VERSES TAB ═══ */}
      {tab==='parallel'&&(()=>{
        // Laid out as Commentaries is: a small line naming the page over the
        // passage, one card per version with its name in a band and the verse
        // beneath in the reading font, and the same bottom bar -- whose middle
        // opens the passage picker.
        const lang=versionLang(readVid);
        const name=bookName(parallelBkData,lang);
        const px=cmPx(readFontSize);
        const card={background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:10,overflow:'hidden'};
        const small={fontFamily:FS,fontSize:UL(9),letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600};
        const navBtn={background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'6px 16px',fontWeight:500,cursor:'pointer'};
        const boxBtn={background:'none',border:`1px solid ${T.bd}`,borderRadius:7,width:32,height:32,display:'inline-flex',alignItems:'center',justifyContent:'center',padding:0,fontSize:U(14),lineHeight:1,cursor:'pointer',flexShrink:0};
        return(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{textAlign:'center',padding:'12px 14px 2px',flexShrink:0}}>
            <div style={{...small,color:T.gM}}>Parallel · {parallelVids.length} {parallelVids.length===1?'version':'versions'}</div>
            <div style={{fontFamily:FS,fontSize:UH(19),fontWeight:600,color:T.gT,letterSpacing:'0.06em',marginTop:4}}>{name} {parallelCh}:{parallelVs}</div>
            <div style={{height:1,background:T.accentLine,marginTop:8}}/>
          </div>
          <div style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',padding:'10px 14px 84px',maxWidth:760,margin:'0 auto',width:'100%',boxSizing:'border-box'}}
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
                <div key={vid} style={card}>
                  <div style={{display:'flex',alignItems:'center',gap:6,padding:'7px 10px 7px 14px',background:T.bgSec,borderBottom:`1px solid ${T.bdS}`}}>
                    <span style={{fontFamily:FS,fontSize:Math.round(px*0.85),fontWeight:700,color:T.gT,letterSpacing:'0.04em'}}>{verDef?.label||vid}</span>
                    <span style={{...small,fontSize:UL(8),color:T.dim,flex:1,marginLeft:4}}>{verDef?.lang}</span>
                    <button type="button" title="Move up" aria-label={`Move ${verDef?.label||vid} up`} disabled={isFirst}
                      onClick={()=>setParallelVids(ids=>{const a=[...ids];[a[idx-1],a[idx]]=[a[idx],a[idx-1]];return a;})}
                      style={{...boxBtn,color:T.gM,opacity:isFirst?0.35:1,cursor:isFirst?'default':'pointer'}}>↑</button>
                    <button type="button" title="Move down" aria-label={`Move ${verDef?.label||vid} down`} disabled={isLast}
                      onClick={()=>setParallelVids(ids=>{const a=[...ids];[a[idx],a[idx+1]]=[a[idx+1],a[idx]];return a;})}
                      style={{...boxBtn,color:T.gM,opacity:isLast?0.35:1,cursor:isLast?'default':'pointer'}}>↓</button>
                    <button type="button" title="Remove" aria-label={`Remove ${verDef?.label||vid}`}
                      onClick={()=>setParallelVids(ids=>ids.filter(id=>id!==vid))}
                      style={{...boxBtn,color:T.dim}}>✕</button>
                  </div>
                  <div style={{padding:'12px 14px 12px'}}>
                    {verseRow
                      ?<div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:px,color:T.body,lineHeight:1.55,textAlign:readTextAlign}} dangerouslySetInnerHTML={{__html:processRedLetter(wojWrap(parallelBk,parallelCh,parallelVs,verseRow.text),readRedLetter,dark)}}/>
                      :<div style={{fontFamily:fontFamilyMap[readFontFamily],fontStyle:'italic',color:T.dim,fontSize:px}}>Not in this version</div>}
                  </div>
                </div>
              );
            })}
            {/* Versions taken off, to put back */}
            {(data?.versions||[]).filter(v=>!parallelVids.includes(v.id)).map(v=>(
              <button key={v.id} type="button" onClick={()=>setParallelVids(ids=>[...ids,v.id])}
                style={{...small,display:'flex',alignItems:'center',justifyContent:'center',gap:6,width:'100%',background:'none',border:`1px dashed ${T.gD}`,borderRadius:10,color:T.gT,padding:'11px 14px',cursor:'pointer',marginBottom:8,boxSizing:'border-box'}}>
                ＋ {v.label}
              </button>
            ))}
          </div>
          <div className="bottom-nav-safe" style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,padding:'1px 12px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <button type="button" onClick={parallelPrevVs} style={navBtn}>‹ Prev</button>
            {/* It opened a sheet that was never drawn, which only froze the page. */}
            <button type="button" onClick={()=>{setNavStep('book');setNavPickedBk(null);setNavPickedCh(null);openReadSheet('nav');}}
              style={{background:'none',border:'none',color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.2em',textTransform:'uppercase',fontWeight:500,cursor:'pointer',padding:'8px 8px'}}>
              {shortBook(name)} {parallelCh}:{parallelVs}
            </button>
            <button type="button" onClick={parallelNextVs} style={navBtn}>Next ›</button>
          </div>
        </div>
        );
      })()}

      {/* ═══ COMMENTARIES TAB ═══ */}
      {tab==='commentaries'&&(
        <CommentaryPage T={T} navH={navH} vid={readVid} verLabel={readVerLabel} lang={versionLang(readVid)} book={cmBook} ch={cmCh} focus={cmFocus}
          list={cmList} cid={cmId} onPick={setCmId} onStep={cmStep} onGo={cmGo} onImport={cmImport} onDelete={cmDelete}
          verseHtml={(b,c,v,t)=>processRedLetter(wojWrap(b,c,v,t),readRedLetter,dark)}
          readFont={{family:fontFamilyMap[readFontFamily],size:readFontSize,lineHeight:readLineHeight}} anySheetOpen={anySheetOpen} installed={bgInstalled}
          fs={fsActive} onScroll={cmScroll} onNav={cmOpenNav} onChoose={v=>setCmFocus(f=>f?.v===v?null:{v,tap:true})}/>
      )}

      {/* ═══ COMPARE TAB ═══ */}
      {tab==='compare'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>

          {/* Sticky controls */}
          <div className="no-print" style={{background:T.bgCard,borderBottom:`1px solid ${T.bd}`,position:'sticky',top:0,zIndex:50,flexShrink:0}}>

            {/* Unified toolbar — desktop only */}
            <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:5,padding:'5px 8px',flexWrap:'nowrap',overflowX:'auto',WebkitOverflowScrolling:'touch'}}>
              <span style={{color:T.gM,fontSize:U(14),flexShrink:0}}>⌕</span>
              <input className="s-btn" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search passages, text, notes…"
                style={{flex:1,minWidth:120,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:U(14),padding:'5px 8px',outline:'none'}}/>
              {q&&<button type="button" className="s-btn s-ghost" title="Clear search" onClick={()=>setQ('')} style={{background:'none',border:'none',color:T.dim,fontSize:U(13),padding:'2px 4px',flexShrink:0}}>✕</button>}
              <div style={{width:1,height:18,background:T.bd,flexShrink:0,margin:'0 2px'}}/>
              <TBtn T={T} ch="＋ Verse" onClick={openAdd} primary/>
              <TBtn T={T} ch="＋ Section" onClick={openAddSec}/>
              <TBtn T={T} ch={<Caret open={false} size={12}/>} onClick={()=>setSecToggle({action:'expand',tick:Date.now()})} title="Expand all"/>
              <TBtn T={T} ch={<Caret open={true} size={12}/>} onClick={()=>setSecToggle({action:'collapse',tick:Date.now()})} title="Collapse all"/>
            </div>

            {/* Mobile action row */}
            <div className="show-mobile" style={{display:'flex',alignItems:'center',gap:6,padding:'6px 10px',borderBottom:`1px solid ${T.bdS}`}}>
              <button type="button" onClick={openAdd}
                style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'8px 0',cursor:'pointer',fontWeight:700,textAlign:'center'}}>
                ＋ Add Verse
              </button>
              <button type="button" onClick={openAddSec}
                style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:8,color:T.mut,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'8px 0',cursor:'pointer',fontWeight:500,textAlign:'center'}}>
                ＋ Section
              </button>
            </div>

            {/* Color key — always visible */}
            <Legend T={T} refLabel={data.versions.find(v=>v.isRef)?.label}/>

            <FilterBar filters={filters} setFilters={setFilters} versions={data.versions} T={T} hiddenVers={hiddenVers} togVer={togVer} onExpand={()=>setSecToggle({action:'expand',tick:Date.now()})} onCollapse={()=>setSecToggle({action:'collapse',tick:Date.now()})}/>
          </div>

          {/* Compare search sheet (mobile) */}
          {mobileSheet==='compareSearch'&&(
            <MobileSheet T={T} title={null} onClose={closeMobileSheet} isClosing={mobileSheetClosing} fromTop topOffset={navH}>
              <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  <button type="button" onClick={closeMobileSheet}
                    style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:U(12),lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    ←
                  </button>
                </div>
                <FitTitle style={{fontFamily:FS,fontSize:UH(22),fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase',maxWidth:'calc(100% - 96px)',textAlign:'center'}}>Search</FitTitle>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
                <input value={q} onChange={e=>setQ(e.target.value)}
                  placeholder="Search passages, text, notes…"
                  style={{flex:1,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:U(15),padding:'8px 10px',outline:'none'}}/>
                {q&&<button type="button" onClick={()=>setQ('')} style={{background:'none',border:'none',color:T.dim,fontSize:U(14),cursor:'pointer',flexShrink:0,padding:'4px'}}>✕</button>}
              </div>
              {q&&<button type="button" onClick={closeMobileSheet}
                style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:UL(9.5),letterSpacing:'0.08em',fontWeight:600,padding:'8px 18px',cursor:'pointer',width:'100%'}}>
                View Results
              </button>}
            </MobileSheet>
          )}

          {/* Content */}
          <div style={{flex:1,overflowY:anySheetOpen?'hidden':'auto'}}>
            <div className="cmp-area" style={{maxWidth:1120,margin:'0 auto',padding:'14px 14px 20px'}}>
              {hasFilter?(
                <>
                  <div style={{fontFamily:FS,fontSize:UL(10),color:T.gM,letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:16,paddingBottom:12,borderBottom:`1px solid ${T.bd}`,fontWeight:600}}>{filtered.length} result{filtered.length!==1?'s':''}{q&&<span style={{color:T.dim,fontWeight:400}}> for "{q}"</span>}</div>
                  {filtered.length===0&&<div style={{textAlign:'center',padding:'48px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(16)}}>No entries match.</div>}
                  {filtered.map((e,i)=><EntryCard key={e.id} entry={e} versions={visibleVersions} q={q} dark={dark} T={T} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulse={pulseId===e.id} idx={i} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>)}
                </>
              ):(
                data.sections.length===0
                  ?<div style={{textAlign:'center',padding:'64px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:U(16)}}>No sections yet. Click + Section to add one.</div>
                  :data.sections.map((sec,si)=>(
                    <Section key={sec.id} sec={sec} entries={data.entries.filter(e=>e.sectionId===sec.id)} versions={visibleVersions} q={q} dark={dark} T={T} onEditSec={openEditSec} onDelSec={openDelSec} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulseId={pulseId} secToggle={secToggle} idx={si} isFirst={si===0} isLast={si===data.sections.length-1} onMoveUp={()=>moveSection(sec.id,'up')} onMoveDown={()=>moveSection(sec.id,'down')} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>
                  ))
              )}
              {!hasFilter&&data.entries.filter(e=>!data.sections.find(s=>s.id===e.sectionId)).map((e,i)=>(
                <EntryCard key={e.id} entry={e} versions={visibleVersions} q={q} dark={dark} T={T} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulse={pulseId===e.id} idx={i} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>
              ))}
            </div>
            <div className="no-print fade-in" style={{textAlign:'center',padding:'16px 24px 32px'}}>
              <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}>
                <div style={{flex:1,height:1,background:T.accentLine}}/><span style={{color:T.gD,fontSize:UL(9)}}>✦</span><div style={{flex:1,height:1,background:T.accentLine}}/>
              </div>
              <div style={{fontFamily:FB,fontStyle:'italic',fontSize:U(14),color:T.dim}}>All renderings should be verified against printed texts.</div>
              <div style={{fontFamily:FS,fontSize:UL(8),letterSpacing:'0.2em',color:T.gD,textTransform:'uppercase',marginTop:6,fontWeight:500}}>To God Alone Be the Glory</div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STRONG'S CONCORDANCE TAB ═══ */}
      {tab==='strongs'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          <div style={{padding:'12px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0}}>
            <div style={{position:'relative',display:'flex'}}>
            <input value={strongsSearchQ} onChange={e=>{
              const val=e.target.value;setStrongsSearchQ(val);setStrongsTabEntry(null);
              if(strongsSearchTimer.current)clearTimeout(strongsSearchTimer.current);
              strongsSearchTimer.current=setTimeout(()=>{
                const q=val.trim();
                if(q.length<2){setStrongsSearchRes(null);return;}
                setStrongsSearchLoading(true);
                dbSearchStrongs(q).then(r=>{setStrongsSearchRes(r);setStrongsSearchLoading(false);}).catch(()=>{setStrongsSearchRes([]);setStrongsSearchLoading(false);});
              },350);
            }} placeholder="Search by Strong's number (H430) or English word…" style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:U(15),padding:'10px 36px 10px 12px',outline:'none',boxSizing:'border-box'}}/>
            {strongsSearchQ&&(
              /* Clears the results with the query, since they are only ever a
                 reflection of it — the same end state as emptying the field by
                 hand, without waiting out the debounce. */
              <button type="button" title="Clear" aria-label="Clear search"
                onClick={()=>{if(strongsSearchTimer.current)clearTimeout(strongsSearchTimer.current);setStrongsSearchQ('');setStrongsSearchRes(null);setStrongsTabEntry(null);}}
                style={{position:'absolute',right:4,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',outline:'none',color:T.dim,fontSize:U(15),lineHeight:1,cursor:'pointer',padding:'7px 8px',WebkitTapHighlightColor:'transparent'}}>
                ✕
              </button>
            )}
            </div>
            <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:6,letterSpacing:'0.08em'}}>
              {strongsSearchLoading?'SEARCHING…':strongsSearchRes?`${strongsSearchRes.length} RESULT${strongsSearchRes.length!==1?'S':''}`:strongsSearchQ.length>0&&strongsSearchQ.length<2?'TYPE AT LEAST 2 CHARACTERS':"STRONG'S CONCORDANCE · 14,197 ENTRIES"}
            </div>
          </div>

          {/* Entry detail view */}
          {strongsTabEntry&&(()=>{
            const te=strongsTabEntry;
            const e=te.entry;
            const verses=te.verses||[];
            const groups={};
            for(const r of verses){
              const key=(r.word_text||'').toLowerCase();
              if(!groups[key])groups[key]={word:r.word_text,refs:new Map()};
              const refKey=`${r.book_num}|${r.chapter}|${r.verse}`;
              groups[key].refs.set(refKey,r.verse_count||1);
            }
            const _FUNC2=new Set(['the','a','an','in','of','from','without','upon','unto','to','for','by','with','at','into','on','and','or','but','nor','so','yet','it','its','he','she','we','they','his','her','their','our','my','thy','thine','mine','ye','thou','thee','him','them','me','us','this','that','these','those','who','whom','whose','which','what','there','here','then','when','where','not','no','as','if','though']);
            const groupList=Object.entries(groups).filter(([k])=>!_FUNC2.has(k)).sort((a,b)=>[...b[1].refs.values()].reduce((s,c)=>s+c,0)-[...a[1].refs.values()].reduce((s,c)=>s+c,0));
            const totalCount=verses[0]?.total_count??new Set(verses.map(r=>`${r.book_num}|${r.chapter}|${r.verse}`)).size;
            function renderDerivation(text){
              if(!text)return null;
              const parts=[];let last=0;
              const re=/([HG]\d+)/g;let m;
              while((m=re.exec(text))!==null){
                if(m.index>last)parts.push(text.slice(last,m.index));
                const raw=m[1],num=normStrongsNum(raw);
                parts.push(<span key={m.index} onClick={()=>{
                  setStrongsTabEntry({strongs_number:num,entry:null,verses:null});
                  Promise.all([dbGetStrongsEntry(num),dbGetStrongsVerses(num)]).then(([entry,vv])=>{
                    setStrongsTabEntry(prev=>prev&&prev.strongs_number===num?{strongs_number:num,entry,verses:vv}:prev);
                  });
                  setStrongsSearchQ(num);
                }} style={{color:T.gT,cursor:'pointer',fontWeight:600,textDecoration:'underline dotted'}}>{num}</span>);
                last=m.index+raw.length;
              }
              if(last<text.length)parts.push(text.slice(last));
              return parts;
            }
            return(
              <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'16px 18px 32px'}}>
                <StrongsEntry T={T} num={te.strongs_number} entry={e} groupList={groupList} totalCount={totalCount}
                  expanded={strongsExpandedWords} onToggle={key=>setStrongsExpandedWords(s=>{const ns=new Set(s);ns.has(key)?ns.delete(key):ns.add(key);return ns;})}
                  onRef={(bn,ch,vs)=>openStrongsVersePreview(bn,ch,vs)}
                  derivation={e?.full_def?renderDerivation(e.full_def):null}
                  readFont={{family:fontFamilyMap[readFontFamily],size:readFontSize}} lang={versionLang(readVid)}
                  trail={<NavIconBtn ch="✕" onClick={()=>{setStrongsTabEntry(null);}} T={T} title="Close"/>}/>
                {e&&(
                  <>
                    {groupList.length===0&&te.versesLoading&&<div style={{fontFamily:FB,fontSize:U(13),color:T.dim,paddingTop:8}}>Loading verses…</div>}
                    {groupList.length===0&&!te.versesLoading&&te.versesOffline&&<div style={{fontFamily:FB,fontSize:U(13),color:T.dim,paddingTop:8,lineHeight:1.5}}>KJV occurrences need a connection. The definition above is saved on your device.</div>}
                  </>
                )}
              </div>
            );
          })()}

          {/* Search results list */}
          {strongsSearchRes&&strongsSearchRes.length>0&&!strongsTabEntry&&(
            <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'6px 0'}}>
              {strongsSearchRes.map(r=>(
                <div key={r.strongs_number} onClick={()=>{
                  const sn=r.strongs_number;
                  setStrongsTabEntry({strongs_number:sn,entry:null,verses:null,versesLoading:true});
                  setStrongsExpandedWords(new Set());
                  fetchStrongsData(sn).then(({entry,verses,versesOffline})=>{
                    setStrongsTabEntry(prev=>prev&&prev.strongs_number===sn?{strongs_number:sn,entry,verses,versesOffline,versesLoading:false}:prev);
                  });
                }}
                  style={{padding:'10px 18px',cursor:'pointer',borderBottom:`1px solid ${T.bd}`,transition:'background .1s'}}
                  onMouseEnter={e=>e.currentTarget.style.background=T.gF}
                  onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:2}}>
                    <span style={{fontFamily:FS,fontSize:U(12),color:T.gT,fontWeight:600,letterSpacing:'0.06em'}}>{r.strongs_number}</span>
                    <span style={{fontFamily:'serif',fontSize:U(16),color:T.body}}>{r.original_word}</span>
                    <span style={{fontFamily:FB,fontSize:U(13),color:T.mut,fontStyle:'italic'}}>{r.transliteration}</span>
                  </div>
                  <div style={{fontFamily:FB,fontSize:U(13),color:T.dim,lineHeight:1.4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.short_def}</div>
                </div>
              ))}
            </div>
          )}
          {strongsSearchRes&&strongsSearchRes.length===0&&(
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:32}}>
              <div style={{fontFamily:FB,fontSize:U(14),color:T.dim,textAlign:'center'}}>No results found for "{strongsSearchQ}"</div>
            </div>
          )}
          {!strongsSearchRes&&!strongsTabEntry&&(
            <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
              {/* Scrollable content area */}
              <div style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',padding:'16px 18px 16px',display:'flex',flexDirection:'column'}}>
                {/* Active custom lexicon search */}
                {activeLexiconId&&activeLexData&&(()=>{
                  const q=lexSearchQ.trim().toLowerCase();
                  const chapters=activeLexData.chapters||[];
                  const filtered=q.length>=2?chapters.filter(c=>c.title.toLowerCase().includes(q)||c.body.toLowerCase().includes(q)):[];
                  return(
                    <div>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                          <span style={{fontFamily:FS,fontSize:UL(10),color:T.gM,letterSpacing:'0.1em'}}>CUSTOM LEXICON</span>
                          <span style={{fontFamily:FB,fontSize:U(13),color:T.gT,fontWeight:600}}>{activeLexData.title}</span>
                          <span style={{fontFamily:FS,fontSize:UL(8),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:3,padding:'1px 5px'}}>{(activeLexData.entryCount||chapters.length).toLocaleString()} entries</span>
                        </div>
                        <button onClick={()=>{setActiveLexiconId(null);try{localStorage.removeItem('scrip:activeLexId');}catch{}}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:UL(8),letterSpacing:'0.08em',padding:'4px 9px',cursor:'pointer',whiteSpace:'nowrap',flexShrink:0}}>Restore Built-in</button>
                      </div>
                      <input value={lexSearchQ} onChange={e=>setLexSearchQ(e.target.value)} placeholder={`Search ${activeLexData.title}…`}
                        style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:U(15),padding:'10px 12px',outline:'none',boxSizing:'border-box',marginBottom:10}}/>
                      {q.length>=2&&filtered.length===0&&<div style={{fontFamily:FB,fontSize:U(13),color:T.dim,padding:'16px 0',textAlign:'center'}}>No matches for "{lexSearchQ}"</div>}
                      {q.length<2&&<div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,letterSpacing:'0.08em',marginBottom:8}}>{q.length>0?'TYPE AT LEAST 2 CHARACTERS':`${(activeLexData.entryCount||chapters.length).toLocaleString()} ENTRIES — SEARCH ABOVE`}</div>}
                      {lexOpenEntry?(
                        <div>
                          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                            <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*1.1),color:T.gT,fontWeight:600}}>{lexOpenEntry.title}</span>
                            <NavIconBtn ch="✕" onClick={()=>setLexOpenEntry(null)} T={T} title="Close"/>
                          </div>
                          <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,whiteSpace:'pre-wrap'}}>{lexOpenEntry.body}</div>
                        </div>
                      ):(
                        filtered.map((c,i)=>(
                          <div key={i} onClick={()=>setLexOpenEntry(c)} style={{padding:'10px 0',borderBottom:`1px solid ${T.bdS}`,cursor:'pointer'}}>
                            <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.gT,fontWeight:600,marginBottom:2}}>{c.title}</div>
                            <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.body.slice(0,120)}</div>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })()}
                {/* No active lexicon — icon + description + uploaded list */}
                {!activeLexiconId&&(
                  <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center'}}>
                    <div style={{fontFamily:FS,fontSize:U(15),fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>Strong's Concordance</div>
                    <div style={{fontFamily:FB,fontSize:U(13),color:T.dim,maxWidth:290,lineHeight:1.7,marginBottom:24}}>Search by Strong's number (e.g. H430, G2316) or English definition.</div>
                    {userLexicons.length>0&&(
                      <div style={{width:'100%',maxWidth:400,textAlign:'left',marginBottom:8}}>
                        <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>UPLOADED LEXICONS</div>
                        {userLexicons.map(lex=>(
                          <div key={lex.id} style={{display:'flex',alignItems:'center',background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:9,padding:'12px 14px',marginBottom:8,gap:10}}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontFamily:FB,fontSize:U(14),color:T.body,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{lex.title}</div>
                              <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:2}}>{(lex.entryCount||0).toLocaleString()} entries · {lex.ext?.toUpperCase()}</div>
                            </div>
                            <button onClick={()=>{setActiveLexiconId(lex.id);setLexSearchQ('');setLexOpenEntry(null);try{localStorage.setItem('scrip:activeLexId',lex.id);}catch{}}}
                              style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'6px 12px',cursor:'pointer',flexShrink:0,fontWeight:600}}>Use This</button>
                            <button onClick={async e=>{e.stopPropagation();if(!window.confirm(`Delete "${lex.title}"?`))return;await idbDeleteResource(lex.id);setUserLexicons(prev=>prev.filter(x=>x.id!==lex.id));}}
                              style={{background:'none',border:'none',color:T.dim,fontSize:U(15),cursor:'pointer',padding:'3px 5px',lineHeight:1}}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* Pinned upload footer — only shown when no active lexicon */}
              {!activeLexiconId&&(
                <div style={{flexShrink:0,borderTop:`1px solid ${T.bd}`,padding:'12px 18px 28px',background:T.bgNav}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
                    <div>
                      <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.12em',marginBottom:5}}>ACCEPTED FORMATS</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px'}}>
                        {['.lexi','.txt','.md','.pdf'].map(f=>(
                          <span key={f} style={{fontFamily:'monospace',fontSize:U(11),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:4,padding:'2px 6px'}}>{f}</span>
                        ))}
                      </div>
                    </div>
                    <label style={{display:'inline-flex',alignItems:'center',gap:7,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'9px 16px',cursor:lexImporting?'default':'pointer',opacity:lexImporting?0.5:1,fontWeight:600,flexShrink:0,whiteSpace:'nowrap'}}>
                      {lexImporting?'Importing…':'＋ Upload Lexicon'}
                      <input type="file" accept={pickerAccept('lexicon')} style={{display:'none'}} disabled={lexImporting}
                        onChange={async e=>{
                          const f=e.target.files[0];if(!f)return;e.target.value='';
                          setLexImporting(true);setLexImportErr('');
                          try{
                            checkPicked(f,'lexicon');
                            const res=await importUserResource(f,'lexicon');
                            const meta={id:res.id,title:res.title,ext:res.ext,importedAt:res.importedAt,kind:res.kind,entryCount:res.entryCount||res.chapters?.length||0};
                            setUserLexicons(prev=>[meta,...prev]);
                          }catch(ex){setLexImportErr(String(ex.message||ex));}
                          setLexImporting(false);
                        }}/>
                    </label>
                  </div>
                  {lexImportErr&&<div style={{marginTop:8,padding:'8px 14px',background:T.red,border:`1px solid ${T.redTxt}44`,borderRadius:8,fontFamily:FB,fontSize:U(12),color:T.redTxt,lineHeight:1.5}}>{lexImportErr}</div>}
                </div>
              )}
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

        // ── Custom dictionary view ──
        if(activeDictId&&activeDictData){
          const dq=lexSearchQ.trim().toLowerCase();
          const chapters=activeDictData.chapters||[];
          const filtered=dq.length>=2?chapters.filter(c=>c.title.toLowerCase().includes(dq)||c.body.toLowerCase().includes(dq)):[];
          return(
            <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
              <div style={{padding:'12px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.1em'}}>CUSTOM DICTIONARY</span>
                    <span style={{fontFamily:FB,fontSize:U(13),color:T.gT,fontWeight:600}}>{activeDictData.title}</span>
                  </div>
                  <button onClick={()=>{setActiveDictId(null);try{localStorage.removeItem('scrip:activeDictId');}catch{}}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:UL(8),letterSpacing:'0.08em',padding:'4px 9px',cursor:'pointer',whiteSpace:'nowrap'}}>Restore Webster's 1828</button>
                </div>
                <input value={lexSearchQ} onChange={e=>{setLexSearchQ(e.target.value);setLexOpenEntry(null);}} placeholder={`Search ${activeDictData.title}…`}
                  style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:U(15),padding:'10px 12px',outline:'none',boxSizing:'border-box'}}/>
                <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:6,letterSpacing:'0.08em'}}>
                  {dq.length>=2?`${filtered.length} RESULT${filtered.length!==1?'S':''}`:dq.length>0?'TYPE AT LEAST 2 CHARACTERS':`${(activeDictData.entryCount||chapters.length).toLocaleString()} ENTRIES`}
                </div>
              </div>
              <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'6px 0 80px'}}>
                {lexOpenEntry?(
                  <div style={{padding:'16px 18px'}}>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
                      <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*1.1),color:T.gT,fontWeight:600}}>{lexOpenEntry.title}</span>
                      <NavIconBtn ch="✕" onClick={()=>setLexOpenEntry(null)} T={T} title="Close"/>
                    </div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,whiteSpace:'pre-wrap'}}>{lexOpenEntry.body}</div>
                  </div>
                ):dq.length>=2&&filtered.length===0?(
                  <div style={{padding:'32px 18px',textAlign:'center',fontFamily:FB,fontSize:U(14),color:T.dim}}>No results for "{lexSearchQ}"</div>
                ):dq.length>=2?(
                  filtered.map((c,i)=>(
                    <div key={i} onClick={()=>setLexOpenEntry(c)} style={{padding:'10px 18px',borderBottom:`1px solid ${T.bdS}`,cursor:'pointer'}}
                      onMouseEnter={el=>el.currentTarget.style.background=T.gF} onMouseLeave={el=>el.currentTarget.style.background='transparent'}>
                      <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.gT,fontWeight:600,marginBottom:2}}>{c.title}</div>
                      <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.body.slice(0,120)}</div>
                    </div>
                  ))
                ):(
                  <div style={{padding:'32px 18px',textAlign:'center',fontFamily:FB,fontSize:U(14),color:T.dim}}>
                    Type at least 2 characters to search {activeDictData.title}.
                  </div>
                )}
              </div>
            </div>
          );
        }

        return(
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
            <div style={{padding:'12px 18px',borderBottom:`1px solid ${T.bd}`,flexShrink:0}}>
              <div style={{position:'relative',display:'flex'}}>
                <input value={dictSearchQ} onChange={e=>{setDictSearchQ(e.target.value);setDictLive(null);setDictDbEntries(null);}} placeholder="Search Webster's 1828…" style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.body,fontFamily:FB,fontSize:U(15),padding:'10px 36px 10px 12px',outline:'none',boxSizing:'border-box'}}/>
                {dictSearchQ&&(
                  <button type="button" title="Clear" aria-label="Clear search"
                    onClick={()=>{setDictSearchQ('');setDictLive(null);setDictDbEntries(null);}}
                    style={{position:'absolute',right:4,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',outline:'none',color:T.dim,fontSize:U(15),lineHeight:1,cursor:'pointer',padding:'7px 8px',WebkitTapHighlightColor:'transparent'}}>
                    ✕
                  </button>
                )}
              </div>
              <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:6,letterSpacing:'0.08em'}}>{statusLabel}</div>
            </div>
            {/* DB results grouped by word then POS */}
            {hasDb&&(
              <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'6px 0'}}>
                {groupedKeys.map(word=>{
                  const entries=grouped[word];
                  return(
                    <div key={word} style={{borderBottom:`1px solid ${T.bdS}`}}>
                      <div style={{padding:'12px 18px 6px',display:'flex',alignItems:'center',gap:8}}>
                        <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*1.05),color:T.gT,fontWeight:600}}>{word.toLowerCase()}</span>
                        <span style={{fontFamily:FS,fontSize:UL(7),letterSpacing:'0.1em',color:T.gM,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:3,padding:'1px 5px',flexShrink:0}}>1828</span>
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
                <Spinner/><div style={{fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',color:T.dim,marginTop:4}}>LOOKING UP…</div>
              </div>
            )}
            {/* External API fallback results */}
            {!isLoading&&!hasDb&&hasLive&&(
              <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'6px 0'}}>
                <div style={{padding:'6px 18px 10px',display:'flex',alignItems:'center',gap:6}}>
                  <span style={{fontFamily:FS,fontSize:UL(7.5),letterSpacing:'0.1em',color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:3,padding:'2px 6px'}}>EXTERNAL SOURCE</span>
                  <span style={{fontFamily:FB,fontSize:UL(10),color:T.dim}}>Not found in Webster's 1828</span>
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
              <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
                {/* Scrollable content: message + uploaded dict list */}
                <div style={{flex:1,overflow:anySheetOpen?'hidden':'auto',padding:'24px 18px 16px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center'}}>
                  <div style={{fontFamily:FB,fontSize:U(14),color:T.dim,maxWidth:310,lineHeight:1.7,marginBottom:28}}>
                    {!q?<>Search for any English word in Webster&rsquo;s 1828 Dictionary. Words not found there (e.g. &ldquo;internet&rdquo;) are automatically looked up via the Free Dictionary API, sourced from Wiktionary.</>:q.length<2?'Type at least 2 characters to search.':'No definition found for "'+dictSearchQ+'".'}
                  </div>
                  {userDicts.length>0&&(
                    <div style={{width:'100%',maxWidth:400,textAlign:'left',marginBottom:8}}>
                      <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>UPLOADED DICTIONARIES</div>
                      {userDicts.map(d=>(
                        <div key={d.id} style={{display:'flex',alignItems:'center',background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:9,padding:'12px 14px',marginBottom:8,gap:10}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontFamily:FB,fontSize:U(14),color:T.body,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.title}</div>
                            <div style={{fontFamily:FS,fontSize:UL(8.5),color:T.dim,marginTop:2}}>{(d.entryCount||0).toLocaleString()} entries · {d.ext?.toUpperCase()}</div>
                          </div>
                          <button onClick={()=>{setActiveDictId(d.id);setLexSearchQ('');setLexOpenEntry(null);try{localStorage.setItem('scrip:activeDictId',d.id);}catch{}}}
                            style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.08em',padding:'6px 12px',cursor:'pointer',flexShrink:0,fontWeight:600}}>Use This</button>
                          <button onClick={async e=>{e.stopPropagation();if(!window.confirm(`Delete "${d.title}"?`))return;await idbDeleteResource(d.id);setUserDicts(prev=>prev.filter(x=>x.id!==d.id));}}
                            style={{background:'none',border:'none',color:T.dim,fontSize:U(15),cursor:'pointer',padding:'3px 5px',lineHeight:1}}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Pinned upload footer */}
                <div style={{flexShrink:0,borderTop:`1px solid ${T.bd}`,padding:'12px 18px 28px',background:T.bgNav}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
                    <div>
                      <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.12em',marginBottom:5}}>ACCEPTED FORMATS</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px'}}>
                        {['.dcti','.txt','.md','.pdf'].map(f=>(
                          <span key={f} style={{fontFamily:'monospace',fontSize:U(11),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:4,padding:'2px 6px'}}>{f}</span>
                        ))}
                      </div>
                    </div>
                    <label style={{display:'inline-flex',alignItems:'center',gap:7,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(10),letterSpacing:'0.1em',padding:'9px 16px',cursor:dictImporting?'default':'pointer',opacity:dictImporting?0.5:1,fontWeight:600,flexShrink:0,whiteSpace:'nowrap'}}>
                      {dictImporting?'Importing…':'＋ Upload Dictionary'}
                      <input type="file" accept={pickerAccept('dict')} style={{display:'none'}} disabled={dictImporting}
                        onChange={async e=>{
                          const f=e.target.files[0];if(!f)return;e.target.value='';
                          setDictImporting(true);setDictImportErr('');
                          try{
                            checkPicked(f,'dict');
                            const res=await importUserResource(f,'dict');
                            const meta={id:res.id,title:res.title,ext:res.ext,importedAt:res.importedAt,kind:res.kind,entryCount:res.entryCount||res.chapters?.length||0};
                            setUserDicts(prev=>[meta,...prev]);
                          }catch(ex){setDictImportErr(String(ex.message||ex));}
                          setDictImporting(false);
                        }}/>
                    </label>
                  </div>
                  {dictImportErr&&<div style={{marginTop:8,padding:'8px 14px',background:T.red,border:`1px solid ${T.redTxt}44`,borderRadius:8,fontFamily:FB,fontSize:U(12),color:T.redTxt,lineHeight:1.5}}>{dictImportErr}</div>}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ MAPS TAB ═══ */}
      {tab==='maps'&&(()=>{
        const BASE=import.meta.env.BASE_URL;
        // Ordered as the story runs, Genesis through Acts. Every plate is a full-resolution
        // scan; the grid reads the small copies under maps/thumb so it never decodes these.
        const MAPS=[
          {title:'The Descendants of Noah',file:'01_Descendants_of_Noah.jpg'},
          {title:'The Land Promised to Abraham',file:'02_Land_Promised_to_Abraham.jpg'},
          {title:'Travels of the Patriarchs',file:'03_Travels_of_the_Patriarchs.jpg'},
          {title:'Egypt, Sinai and the Wilderness',file:'04_Egypt_Sinai_and_the_Wilderness.jpg'},
          {title:'Canaan and the Twelve Tribes',file:'05_Canaan_and_the_Twelve_Tribes.jpg'},
          {title:'The Holy Land Among the Twelve Tribes',file:'06_The_Holy_Land_Among_the_Twelve_Tribes.jpg'},
          {title:'Judaea Divided Among the Twelve Tribes',file:'07_Judaea_Divided_Among_the_Twelve_Tribes.jpg'},
          {title:'Palaestina in XII Tribus',file:'08_Palaestina_in_XII_Tribus.jpg'},
          {title:'Terra Sancta, the Land of Promise',file:'09_Terra_Sancta_the_Land_of_Promise.jpg'},
          {title:'The Kingdom of David and Solomon',file:'10_Kingdom_of_David_and_Solomon.jpg'},
          {title:'The Holy Land at Successive Periods',file:'11_The_Holy_Land_at_Successive_Periods.jpg'},
          {title:'The Holy Land: Northern Division',file:'12_The_Holy_Land_Northern_Division.jpg'},
          {title:'The Holy Land: Southern Division',file:'13_The_Holy_Land_Southern_Division.jpg'},
          {title:'Sacred Geography of Judaea',file:'14_Sacred_Geography_of_Judaea.jpg'},
          {title:'Jerusalem, Ancient and Modern',file:'15_Jerusalem_Ancient_and_Modern.jpg'},
          {title:'Environs of Jerusalem',file:'16_Environs_of_Jerusalem.jpg'},
          {title:'Journeys of Christ and the Apostles',file:'17_Journeys_of_Christ_and_the_Apostles.jpg'},
        ];
        return(
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
            {/* Header */}
            <div style={{padding:'14px 16px 10px',borderBottom:`1px solid ${T.bdS}`,flexShrink:0}}>
              <div style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Scripture Atlas</div>
              <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginTop:2}}>{MAPS.length} built-in · {userMaps.length} imported</div>
            </div>
            {/* Map grid */}
            <div style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',padding:'10px 12px 16px'}}>
              {/* User-imported maps */}
              {userMaps.length>0&&(
                <div style={{marginBottom:18}}>
                  <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10,paddingLeft:4}}>IMPORTED MAPS</div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:10}}>
                    {userMaps.map(m=>(
                      <div key={m.id} style={{position:'relative',background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,overflow:'hidden',cursor:'pointer',aspectRatio:'4/3',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}
                        onClick={async()=>{
                          const blob=await idbGetResourceBlob(m.id);
                          if(blob?.data){const url=URL.createObjectURL(new Blob([blob.data],{type:m.mime}));setViewingBlob({url,title:m.title,kind:m.kind,id:m.id});}
                        }}>
                        {m.kind==='image'?(
                          <UserBlobThumb id={m.id} mime={m.mime} title={m.title} T={T}/>
                        ):(
                          <div style={{textAlign:'center',padding:12}}>
                            <div style={{fontSize:UH(28),marginBottom:6}}>▤</div>
                            <div style={{fontFamily:FB,fontSize:U(11),color:T.body,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{m.title}</div>
                            <div style={{fontFamily:FS,fontSize:UL(8),color:T.dim,marginTop:4}}>PDF</div>
                          </div>
                        )}
                        <button type="button" onClick={async e=>{e.stopPropagation();if(!window.confirm(`Delete "${m.title}"?`))return;await idbDeleteResource(m.id);setUserMaps(prev=>prev.filter(x=>x.id!==m.id));}}
                          style={{position:'absolute',top:4,right:4,background:'rgba(0,0,0,0.55)',border:'none',color:'#fff',fontSize:U(12),cursor:'pointer',borderRadius:6,padding:'2px 6px',lineHeight:1}}>✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{height:1,background:T.bdS,margin:'18px 0'}}/>
                </div>
              )}
              {/* Built-in maps */}
              <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10,paddingLeft:4}}>BUILT-IN MAPS</div>
              <MapLightboxGrid maps={MAPS} BASE={BASE} T={T}/>
              <div style={{fontFamily:FB,fontSize:UL(9),color:T.dim,textAlign:'center',lineHeight:1.6,padding:'18px 14px 4px'}}>Scans courtesy of the David Rumsey Map Collection, davidrumsey.com. The maps themselves are in the public domain.</div>
            </div>
            {/* Import footer */}
            <div style={{flexShrink:0,borderTop:`1px solid ${T.bd}`,padding:'12px 18px 28px',background:T.bgNav}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
                <div>
                  <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.12em',marginBottom:5}}>ACCEPTED FORMATS</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px'}}>
                    {['.jpg','.png','.webp','.pdf'].map(f=>(
                      <span key={f} style={{fontFamily:'monospace',fontSize:U(11),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:4,padding:'2px 6px'}}>{f}</span>
                    ))}
                  </div>
                </div>
                <label style={{display:'inline-flex',alignItems:'center',gap:6,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',padding:'8px 14px',cursor:'pointer',fontWeight:600,flexShrink:0,opacity:mapsImporting?0.5:1}}>
                  {mapsImporting?'Importing…':'＋ Import Map'}
                  <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style={{display:'none'}} disabled={mapsImporting}
                    onChange={async e=>{
                      const f=e.target.files[0];if(!f)return;e.target.value='';
                      setMapsImporting(true);setMapsImportErr('');
                      try{const res=await importUserResource(f,'maps');setUserMaps(prev=>[{id:res.id,title:res.title,ext:res.ext,importedAt:res.importedAt,kind:res.kind,mime:res.mime,size:res.size},...prev]);}
                      catch(ex){setMapsImportErr(String(ex.message||ex));}
                      setMapsImporting(false);
                    }}/>
                </label>
              </div>
              {mapsImportErr&&<div style={{marginTop:8,fontFamily:FB,fontSize:U(11),color:T.redTxt}}>{mapsImportErr}</div>}
            </div>
          </div>
        );
      })()}

      {/* ═══ CHARTS TAB ═══ */}
      {tab==='charts'&&(()=>{
        const BASE=import.meta.env.BASE_URL;
        const LARKIN_SECTIONS=[
          {title:'Rightly Dividing the Word',imgs:Array.from({length:30},(_,i)=>`Rightly_Dividing_the_Word__${String(i+1).padStart(2,'0')}.png`)},
          {title:'Mountain Peaks of Prophecy',imgs:['Mountain_Peaks_of_Prophecy__01.png','Mountain_Peaks_of_Prophecy__02.png']},
          {title:'The Prophetic Word',imgs:['The_Prophetic_Word__01.png']},
          {title:'The Spirit World',imgs:Array.from({length:5},(_,i)=>`The_Spirit_World__${String(i+1).padStart(2,'0')}.png`)},
          {title:'The Church',imgs:['The_Church__01.png','The_Church__02.png','The_Church__03.png','The_Church__04.png']},
          {title:'The Covenants',imgs:['The_Covenants__01.png','The_Covenants__02.png']},
          {title:'The Dispensational Work of the Lord Jesus Christ',imgs:['The_Dispensational_Work_of_the_Lord_Jesus_Christ__01.png','The_Dispensational_Work_of_the_Lord_Jesus_Christ__02.png']},
          {title:'The Feasts of the Lord',imgs:['The_Feasts_of_the_Lord__01.png','The_Feasts_of_the_Lord__02.png']},
          {title:'The Four Gospels',imgs:['The_Four_Gospels__01.png','The_Four_Gospels__02.png']},
          {title:'The Seven Churches',imgs:['The_Seven_Churches__01.png','The_Seven_Churches__02.png','The_Seven_Churches__03.png','The_Seven_Churches__04.png']},
          {title:'The Gentiles',imgs:Array.from({length:5},(_,i)=>`The_Gentiles__${String(i+1).padStart(2,'0')}.png`)},
          {title:'The Jews',imgs:['The_Jews__01.png','The_Jews__02.png','The_Jews__03.png','The_Jews__04.png']},
          {title:'The Kingdom',imgs:Array.from({length:5},(_,i)=>`The_Kingdom__${String(i+1).padStart(2,'0')}.png`)},
          {title:'The King',imgs:['The_King__01.png','The_King__02.png','The_King__03.png']},
          {title:'The Judgments',imgs:['The_Judgments__01.png','The_Judgments__02.png']},
          {title:'The Resurrection',imgs:['The_Resurrection__01.png','The_Resurrection__02.png']},
          {title:'The Second Coming of Christ',imgs:['The_Second_Coming_of_Christ__01.png','The_Second_Coming_of_Christ__02.png','The_Second_Coming_of_Christ__03.png','The_Second_Coming_of_Christ__04.png']},
          {title:'The Tribulation',imgs:['The_Tribulation__01.png','The_Tribulation__02.png','The_Tribulation__03.png']},
          {title:'The Antichrist',imgs:Array.from({length:12},(_,i)=>`The_Antichrist__${String(i+1).padStart(2,'0')}.png`)},
          {title:'The Satanic Trinity',imgs:['The_Satanic_Trinity__01.png','The_Satanic_Trinity__02.png']},
          {title:'Satan',imgs:['Satan__01.png','Satan__02.png']},
          {title:'The Mysteries',imgs:['The_Mysteries__01.png']},
          {title:'The Offerings',imgs:['The_Offerings__01.png']},
          {title:'The Signs of the Times',imgs:['The_Signs_of_the_Times__01.png']},
          {title:'Renovation of the Earth',imgs:['Renovation_of_the_Earth__01.png','Renovation_of_the_Earth__02.png','Renovation_of_the_Earth__03.png']},
          {title:'Three Trees to Which Israel is Compared',imgs:['Three_Trees_to_Which_Israel_is_Compared__01.png','Three_Trees_to_Which_Israel_is_Compared__02.png','Three_Trees_to_Which_Israel_is_Compared__03.png']},
          {title:'Types and Anti-Types',imgs:['Types_and_Anti-Types__01.png','Types_and_Anti-Types__02.png','Types_and_Anti-Types__03.png']},
          {title:'Scripture Numerics',imgs:['Scripture_Numerics__01.png']},
          {title:'Spiritism',imgs:['Spiritism__01.png']},
          {title:'Dispensational Teaching of the Great Pyramid',imgs:['Dispensational_Teaching_of_the_Great_Pyramid__01.png','Dispensational_Teaching_of_the_Great_Pyramid__02.png','Dispensational_Teaching_of_the_Great_Pyramid__03.png']},
        ];
        // Flatten all images into one array for lightbox prev/next
        const allImgs=LARKIN_SECTIONS.flatMap(s=>s.imgs.map(img=>({section:s.title,img})));
        return(
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
            {/* Header */}
            <div style={{padding:'14px 16px 10px',borderBottom:`1px solid ${T.bdS}`,flexShrink:0}}>
              <div style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Larkin's Charts</div>
              <div style={{fontFamily:FB,fontSize:U(11),color:T.dim,marginTop:2}}>Clarence Larkin · Dispensational Truth (1918) · {allImgs.length} built-in · {userCharts.length} imported</div>
            </div>
            {/* Scrollable sections */}
            <div style={{flex:1,overflowY:anySheetOpen?'hidden':'auto',padding:'8px 12px 16px'}}>
              {/* User-imported charts */}
              {userCharts.length>0&&(
                <div style={{marginBottom:18}}>
                  <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10,paddingLeft:4}}>IMPORTED CHARTS</div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:10}}>
                    {userCharts.map(m=>(
                      <div key={m.id} style={{position:'relative',background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,overflow:'hidden',cursor:'pointer',aspectRatio:'4/3',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}
                        onClick={async()=>{
                          const blob=await idbGetResourceBlob(m.id);
                          if(blob?.data){const url=URL.createObjectURL(new Blob([blob.data],{type:m.mime}));setViewingBlob({url,title:m.title,kind:m.kind,id:m.id});}
                        }}>
                        {m.kind==='image'?(
                          <UserBlobThumb id={m.id} mime={m.mime} title={m.title} T={T}/>
                        ):(
                          <div style={{textAlign:'center',padding:12}}>
                            <div style={{fontSize:UH(28),marginBottom:6}}>▤</div>
                            <div style={{fontFamily:FB,fontSize:U(11),color:T.body,lineHeight:1.3,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{m.title}</div>
                            <div style={{fontFamily:FS,fontSize:UL(8),color:T.dim,marginTop:4}}>PDF</div>
                          </div>
                        )}
                        <button type="button" onClick={async e=>{e.stopPropagation();if(!window.confirm(`Delete "${m.title}"?`))return;await idbDeleteResource(m.id);setUserCharts(prev=>prev.filter(x=>x.id!==m.id));}}
                          style={{position:'absolute',top:4,right:4,background:'rgba(0,0,0,0.55)',border:'none',color:'#fff',fontSize:U(12),cursor:'pointer',borderRadius:6,padding:'2px 6px',lineHeight:1}}>✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{height:1,background:T.bdS,margin:'18px 0'}}/>
                </div>
              )}
              {/* Built-in Larkin sections */}
              <div style={{fontFamily:FS,fontSize:UL(9),color:T.gM,letterSpacing:'0.14em',marginBottom:10,paddingLeft:4}}>LARKIN'S CHARTS</div>
              {LARKIN_SECTIONS.map(({title,imgs})=>(
                <LarkinSection key={title} title={title} imgs={imgs} BASE={BASE} T={T} allImgs={allImgs}/>
              ))}
            </div>
            {/* Import footer */}
            <div style={{flexShrink:0,borderTop:`1px solid ${T.bd}`,padding:'12px 18px 28px',background:T.bgNav}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
                <div>
                  <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.12em',marginBottom:5}}>ACCEPTED FORMATS</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px'}}>
                    {['.jpg','.png','.webp','.pdf'].map(f=>(
                      <span key={f} style={{fontFamily:'monospace',fontSize:U(11),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:4,padding:'2px 6px'}}>{f}</span>
                    ))}
                  </div>
                </div>
                <label style={{display:'inline-flex',alignItems:'center',gap:6,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',padding:'8px 14px',cursor:'pointer',fontWeight:600,flexShrink:0,opacity:chartsImporting?0.5:1}}>
                  {chartsImporting?'Importing…':'＋ Import Chart'}
                  <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" style={{display:'none'}} disabled={chartsImporting}
                    onChange={async e=>{
                      const f=e.target.files[0];if(!f)return;e.target.value='';
                      setChartsImporting(true);setChartsImportErr('');
                      try{const res=await importUserResource(f,'charts');setUserCharts(prev=>[{id:res.id,title:res.title,ext:res.ext,importedAt:res.importedAt,kind:res.kind,mime:res.mime,size:res.size},...prev]);}
                      catch(ex){setChartsImportErr(String(ex.message||ex));}
                      setChartsImporting(false);
                    }}/>
                </label>
              </div>
              {chartsImportErr&&<div style={{marginTop:8,fontFamily:FB,fontSize:U(11),color:T.redTxt}}>{chartsImportErr}</div>}
            </div>
          </div>
        );
      })()}

      {/* ═══ OTHER RESOURCES TAB ═══ */}
      {tab==='other'&&(
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0,paddingTop:navH}}>
          {!openResId?(
            <>
            {/* ── Resource list ── */}
            <div style={{flex:1,overflowY:'auto',padding:'20px 16px 16px'}}>
              <div style={{marginBottom:18}}>
                <div style={{fontFamily:FS,fontSize:U(13),fontWeight:700,color:T.gT,letterSpacing:'0.1em',textTransform:'uppercase'}}>Other Resources</div>
              </div>
              {resources.length===0&&!resImporting&&(
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center',minHeight:'55vh',padding:'24px'}}>
                  <div style={{fontSize:UH(36),marginBottom:16,opacity:0.4}}>▤</div>
                  <div style={{fontFamily:FS,fontSize:U(13),color:T.gT,letterSpacing:'0.08em',marginBottom:10}}>No Resources Yet</div>
                  <div style={{fontFamily:FB,fontSize:U(14),color:T.dim,lineHeight:1.7,maxWidth:280,margin:'0 auto'}}>Import books, commentaries, devotionals, cross-references, PDFs, and more.</div>
                </div>
              )}
              {resources.map(res=>{
                const kindIcon=res.kind==='pdf'?'▤':res.kind==='image'?'▣':res.kind==='sqlite'?'▦':'▥';
                const kindLabel=res.kind==='pdf'?'PDF':res.kind==='image'?res.ext?.toUpperCase()||'Image':res.kind==='sqlite'?`${(res.entryCount||res.chapters?.length||0).toLocaleString()} entries`:(`${(res.chapters?.length||1)} ${(res.chapters?.length||1)===1?'section':'chapters'}`);
                return(
                <div key={res.id} style={{display:'flex',alignItems:'center',background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,padding:'14px 16px',marginBottom:10,cursor:'pointer',gap:12}}
                  onClick={async()=>{
                    if(res.kind==='pdf'||res.kind==='image'){
                      const blob=await idbGetResourceBlob(res.id);
                      if(blob?.data){const url=URL.createObjectURL(new Blob([blob.data],{type:res.mime}));setViewingBlob({url,title:res.title,kind:res.kind,id:res.id});}
                      return;
                    }
                    const full=await idbGetResourceWithChapters(res.id);
                    if(full){setOpenResData(full);setOpenResChapter(0);setOpenResId(res.id);}
                  }}>
                  <div style={{fontSize:UH(22),flexShrink:0}}>{kindIcon}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:FB,fontSize:U(16),color:T.body,fontWeight:600,marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{res.title}</div>
                    <div style={{fontFamily:FS,fontSize:UL(9),color:T.dim,letterSpacing:'0.08em',textTransform:'uppercase'}}>
                      {kindLabel} · {res.ext?.toUpperCase()} · {new Date(res.importedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <button type="button"
                      onClick={async e=>{e.stopPropagation();if(!window.confirm(`Delete "${res.title}"?`))return;await idbDeleteResource(res.id);setResources(prev=>prev.filter(r=>r.id!==res.id));}}
                      title="Delete" aria-label="Delete"
                      style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:9,color:T.dim,fontSize:U(15),cursor:'pointer',width:36,height:36,minWidth:36,padding:0,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1,flexShrink:0,boxSizing:'border-box'}}>✕</button>
                    {res.kind!=='pdf'&&res.kind!=='image'&&<div style={{color:T.gM,fontSize:UH(18),opacity:0.5}}>›</div>}
                  </div>
                </div>
                );
              })}
            </div>
            {/* Import footer */}
            <div style={{flexShrink:0,borderTop:`1px solid ${T.bd}`,padding:'12px 18px 28px',background:T.bgNav}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
                <div>
                  <div style={{fontFamily:FS,fontSize:UL(8),color:T.gM,letterSpacing:'0.12em',marginBottom:5}}>ACCEPTED FORMATS</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:'4px 8px'}}>
                    {['.txt','.md','.pdf','.jpg','.png','.cmti','.devi','.refi','.dzip'].map(f=>(
                      <span key={f} style={{fontFamily:'monospace',fontSize:U(11),color:T.dim,background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:4,padding:'2px 6px'}}>{f}</span>
                    ))}
                  </div>
                </div>
                <label style={{display:'inline-flex',alignItems:'center',gap:6,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:UL(9),letterSpacing:'0.1em',padding:'8px 14px',cursor:'pointer',fontWeight:600,flexShrink:0,opacity:resImporting?0.5:1}}>
                  {resImporting?'Importing…':'＋ Import Resource'}
                  <input type="file" accept={pickerAccept('other')} style={{display:'none'}} disabled={resImporting}
                    onChange={async e=>{
                      const f=e.target.files[0];if(!f)return;
                      e.target.value='';
                      setResImporting(true);setResImportErr('');setResNote('');
                      try{
                        checkPicked(f,'other');
                        // A commentary has a page of its own, which follows the passage.
                        if(/\.cmti$/i.test(f.name)){const c=await cmImport(f);setResNote(`\u201c${c.title}\u201d is in Study \u2192 Commentaries.`);}
                        else{const res=await importUserResource(f,'other');setResources(prev=>[res,...prev]);}
                      }catch(ex){setResImportErr(String(ex.message||ex));}
                      setResImporting(false);
                    }}/>
                </label>
              </div>
              {resImportErr&&<div style={{marginTop:8,fontFamily:FB,fontSize:U(11),color:T.redTxt}}>{resImportErr}</div>}
              {resNote&&<div style={{marginTop:8,fontFamily:FB,fontSize:U(12),color:T.gM}}>{resNote}</div>}
            </div>
            </>
          ):(
            /* ── Resource reader ── */
            <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minHeight:0}}>
              {/* Top bar — back left, title absolutely centered, counter right */}
              <div style={{position:'relative',display:'flex',alignItems:'center',padding:'10px 14px',borderBottom:`1px solid ${T.bd}`,background:T.bgNav,flexShrink:0}}>
                <span style={{zIndex:1,display:'inline-flex'}}>
                  <NavIconBtn ch="‹" label="Library" T={T} title="Back to library"
                    onClick={()=>{setOpenResId(null);setOpenResData(null);setOpenResChapter(0);}}/>
                </span>
                {/* Absolutely centered title — unaffected by sibling widths */}
                <div style={{position:'absolute',left:0,right:0,textAlign:'center',pointerEvents:'none'}}>
                  <span style={{fontFamily:FS,fontSize:U(12),color:T.gT,letterSpacing:'0.06em'}}>{openResData?.title}</span>
                </div>
                <div style={{marginLeft:'auto',fontFamily:FS,fontSize:U(11),color:T.dim,letterSpacing:'0.06em',flexShrink:0,zIndex:1}}>
                  {openResData?.chapters?.length>1?`${openResChapter+1}/${openResData.chapters.length}`:''}
                </div>
              </div>
              {/* Content */}
              <div key={`${openResId}-${openResChapter}`} style={{flex:1,overflowY:'auto',padding:`28px ${Math.max(20,Math.min(48,window.innerWidth*0.07))}px 24px`}}
                onTouchStart={e=>{swipeTouchX.current=e.touches[0].clientX;swipeTouchY.current=e.touches[0].clientY;swipeTouchT.current=Date.now();swipeDir.current=null;}}
                onTouchMove={e=>{if(swipeTouchX.current===null)return;const dx=e.touches[0].clientX-swipeTouchX.current;const dy=e.touches[0].clientY-swipeTouchY.current;if(!swipeDir.current&&(Math.abs(dx)>12||Math.abs(dy)>12)){swipeDir.current=Math.abs(dx)>Math.abs(dy)?'h':'v';}}}
                onTouchEnd={e=>{if(swipeTouchX.current===null)return;const wasH=swipeDir.current==='h';const dx=e.changedTouches[0].clientX-swipeTouchX.current;const dt=Math.max(1,Date.now()-swipeTouchT.current);const velocity=Math.abs(dx)/dt;swipeTouchX.current=null;swipeDir.current=null;if(!wasH)return;if(Math.abs(dx)<60&&velocity<0.35)return;if(dx<0)setOpenResChapter(c=>Math.min((openResData?.chapters?.length||1)-1,c+1));else setOpenResChapter(c=>Math.max(0,c-1));}}>
                {openResData?.chapters?.[openResChapter]?.title&&(
                  <div style={{fontFamily:FS,fontSize:U(13),color:T.gM,letterSpacing:'0.1em',textTransform:'uppercase',marginBottom:24,textAlign:'center'}}>{openResData.chapters[openResChapter].title}</div>
                )}
                {openResData?.chapters?.[openResChapter]?.body
                  ?.split(/\n{2,}/)
                  .filter(p=>p.trim())
                  .map((para,i)=>(
                    <p key={i} style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textAlign:readTextAlign,margin:`0 0 ${Math.round(readFontSize*1.1)}px`}}>{para.trim()}</p>
                  ))
                }
              </div>
              {/* Bottom nav — matches Bible reader exactly */}
              {openResData?.chapters?.length>1&&(
                <div className="bottom-nav-safe" style={{borderTop:`1px solid ${T.bdS}`,background:T.bgCard,flexShrink:0,display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 12px 0',minHeight:49,boxSizing:'border-box'}}>
                  <button type="button" className="s-btn s-ghost" disabled={openResChapter===0}
                    onClick={()=>setOpenResChapter(c=>Math.max(0,c-1))}
                    style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',fontWeight:500,width:UL(90),minHeight:U(34),overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0,opacity:openResChapter===0?0.3:1}}>
                    {'‹'} {openResChapter>0?(openResData.chapters[openResChapter-1]?.title||`Ch ${openResChapter}`):''}
                  </button>
                  <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                    <span style={{fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',color:T.dim,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',textTransform:'uppercase'}}>
                      {openResData.chapters[openResChapter]?.title||`Chapter ${openResChapter+1}`}
                    </span>
                  </div>
                  <button type="button" className="s-btn s-ghost" disabled={openResChapter===openResData.chapters.length-1}
                    onClick={()=>setOpenResChapter(c=>Math.min(openResData.chapters.length-1,c+1))}
                    style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',fontWeight:500,width:UL(90),minHeight:U(34),overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0,opacity:openResChapter===openResData.chapters.length-1?0.3:1}}>
                    {openResChapter<openResData.chapters.length-1?(openResData.chapters[openResChapter+1]?.title||`Ch ${openResChapter+2}`):''} {'›'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ BLOB VIEWER (PDF / Image overlay) ═══ */}
      {viewingBlob&&(
        <div style={{position:'fixed',inset:0,zIndex:950,background:'rgba(0,0,0,0.92)',display:'flex',flexDirection:'column'}} onClick={e=>{if(e.target===e.currentTarget){URL.revokeObjectURL(viewingBlob.url);setViewingBlob(null);}}}>
          {/* Header bar */}
          <div style={{display:'flex',alignItems:'center',gap:10,padding:`max(calc(var(--sat,0px) + 10px),var(--sat-min,20px)) 14px 10px`,background:'rgba(0,0,0,0.6)',flexShrink:0,backdropFilter:'blur(8px)'}}>
            <button type="button" onClick={()=>{URL.revokeObjectURL(viewingBlob.url);setViewingBlob(null);}} title="Close" aria-label="Close" style={{background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.25)',borderRadius:9,color:'rgba(255,255,255,0.85)',fontSize:UH(17),cursor:'pointer',width:40,height:40,minWidth:40,padding:0,display:'inline-flex',alignItems:'center',justifyContent:'center',lineHeight:1,flexShrink:0,boxSizing:'border-box'}}>✕</button>
            <div style={{flex:1,overflow:'hidden',textAlign:'center'}}>
              <div style={{fontFamily:'system-ui,sans-serif',fontSize:U(13),color:'rgba(255,255,255,0.9)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{viewingBlob.title}</div>
            </div>
            <div style={{width:40,flexShrink:0}}/>
          </div>
          {/* Content */}
          <div style={{flex:1,overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center',padding:8}}>
            {viewingBlob.kind==='pdf'?(
              <iframe src={viewingBlob.url} title={viewingBlob.title} style={{width:'100%',height:'100%',border:'none',borderRadius:6,background:'#fff'}}/>
            ):(
              <img src={viewingBlob.url} alt={viewingBlob.title} style={{maxWidth:'100%',maxHeight:'100%',objectFit:'contain',borderRadius:8,userSelect:'none'}} draggable={false}/>
            )}
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
      {modal?.type==='versions'&&<VersionsModal data={data} onSave={saveVersions} onClose={closeModal} onBack={()=>closeModal(()=>setReadMobileSheet('version'))} T={T} dlStates={dlStates} onDownload={startDownload} onDeleteLocal={deleteDownload} navH={navH} isClosing={modalClosing} user={user}/>}
      {/* Opened from the Study tiles, back returns to Study Tools; from anywhere
          else it closes, as before. */}
      {modal?.type==='bookmarks'&&<BookmarksPanel readFont={{family:fontFamilyMap[readFontFamily],size:readFontSize}} T={T} bookmarks={bookmarks} categories={bmCategories} onDelete={handleDelBookmark} onOpen={openFromBookmark} onClose={closeModal} onBack={studyBack} onUpdate={handleUpdateBookmark} onAddCat={handleAddCategory} onDeleteCat={handleDeleteCategory} onUpdateCat={handleUpdateCategory} versions={data.versions} user={user} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='highlights'&&<HighlightsPanel T={T} dark={dark} highlights={highlights} versions={data.versions} onOpen={openFromHighlight} onClose={closeModal} onBack={studyBack} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='recents'&&<RecentsPanel T={T} recents={recents} onOpen={openFromRecent} onClose={closeModal} onBack={studyBack} versions={data.versions} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='stats'&&<StatsModal data={data} T={T} onClose={()=>setModal(null)}/>}
      {verDelAsk&&(()=>{
        const n=verDelAsk.names,one=n.length===1;
        const answer=ok=>{const r=verDelAsk.resolve;setVerDelAsk(null);r(ok);};
        return(
          <ConfirmDialog T={T} danger
            title={one?`Delete ${n[0]}?`:`Delete ${n.length} versions?`}
            message={`${one?n[0]:n.join(', ')} and any highlights in ${one?'it':'them'} will be deleted from this device and removed from your list on every device. Scriptorium can't restore ${one?'it':'them'} — you would need the original file to import ${one?'it':'them'} again.`}
            confirmLabel="Delete" cancelLabel="Keep"
            onConfirm={()=>answer(true)} onCancel={()=>answer(false)}/>
        );
      })()}
      {/* A Strong's occurrence, read where it was tapped: in the popup over Read,
          or on the Strong's Concordance page. */}
      {strongsVersePreview&&(
        <VersePreview T={T} title={strongsVersePreview.label} sub={readVerLabel} readFont={{family:fontFamilyMap[readFontFamily],size:readFontSize}}
          loading={strongsVersePreview.loading}
          rows={strongsVersePreview.loading||!strongsVersePreview.text?[]:[{key:'v',label:strongsVersePreview.vs,html:processRedLetter(wojWrap(strongsVersePreview.bn,strongsVersePreview.ch,strongsVersePreview.vs,strongsVersePreview.text),readRedLetter,dark)}]}
          onClose={()=>setStrongsVersePreview(null)}
          onGo={()=>{const p=strongsVersePreview;setStrongsPopup(null);setStrongsVersePreview(null);
            if(p.bn===readBook&&p.ch===readCh){readScrollToVerse.current=null;setTab('read');landOnVerse(p.vs,true);}
            else{readScrollToVerse.current=p.vs;landSilent.current=true;setReadBook(p.bn);setReadCh(p.ch);setTab('read');}}}/>
      )}
      {bmDialog&&(
        <BookmarkDialog T={T} d={bmDialog} readFont={{family:fontFamilyMap[readFontFamily],size:readFontSize}}
          rows={[...readSelVerses].sort((x,y)=>x-y).map(v=>{const r=readVerses.find(x=>x.verse===v);return r?{key:v,label:v,html:processRedLetter(wojWrap(readBook,readCh,v,r.text),readRedLetter,dark)}:null;}).filter(Boolean)}
          categories={bmCategories} canCategorize={!!(user&&!user.guest)}
          onChange={patch=>setBmDialog(x=>({...x,...patch}))} onSave={saveBookmarkFromDialog} onCancel={()=>setBmDialog(null)}/>
      )}
      {/* Alongside the plan rather than inside the reading tab, since it belongs
          to the reminder rather than to whatever tab happens to be showing. */}
      {timePicker&&(
        <TimePicker T={T} value={timePicker.value}
          onCancel={()=>setTimePicker(null)}
          onSet={t=>{const f=timePicker.onSet;setTimePicker(null);f(t);}}/>
      )}
      {modal?.type==='plan'&&(()=>{
        // planState is read once at mount, so its year goes stale if the app is
        // left open across New Year. The day number always comes from today's
        // date, so take the year from there too or the two disagree and the
        // Psalms stop landing on Sundays until the app is restarted.
        const planYear=new Date().getFullYear();
        const plan=buildYearPlan(planYear);
        const today=planDayOfYear();
        const lang=readLang;
        const labels=planYearLabels(planYear,lang);
        const done=new Set(planState.done);
        const pct=Math.round(done.size/PLAN_DAYS*100);
        // Always lands on the first verse of the reading, including verse 1,
        // and always quietly: you followed a link to read a passage, not to act
        // on a verse. Already in that chapter the chapter effect will not run
        // again, so nothing would consume readScrollToVerse -- land it here.
        const open=(b,c,v,day)=>{openPlanPassage(b,c,v,day,labels[day-1]);closeModal();};
        const planRemindOn=(time)=>{
          const v={on:true,time};
          setPlanRemind(v);
          setPlanRemindBusy(true);
          planSyncReminders(true,time,planYear,lang).then(r=>{
            setPlanRemindBusy(false);
            if(!r.ok){
              // Denied at the system level: saying so beats a switch that
              // silently refuses to stay on.
              setPlanRemind({on:false,time:PLAN_REMIND_TIME});
              setPlanRemindMsg(r.denied?'Allow notifications for Scriptorium in iOS Settings, then try again.':'Could not set the reminder.');
              return;
            }
            setPlanRemindMsg('');
            planRemindSave(v);
          });
        };
        const planRemindOff=()=>{
          // Off forgets the time too, so switching back on starts by asking.
          const v={on:false,time:PLAN_REMIND_TIME};
          setPlanRemind(v);planRemindSave(v);setPlanRemindMsg('');
          planSyncReminders(false,v.time,planYear,lang);
        };
        const Passages=({day})=>(
          <div style={{display:'flex',flexWrap:'wrap',gap:6,marginTop:6}}>
            {labels[day-1].map((r,i)=>(
              <button key={i} type="button" onClick={()=>open(r.b,r.c,r.v,day)}
                style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FB,fontSize:U(15),padding:'6px 11px',cursor:'pointer',whiteSpace:'nowrap'}}>
                {r.label}
              </button>
            ))}
          </div>
        );
        const Tick=({day})=>(
          <button type="button" onClick={()=>planToggleDay(day)}
            title={done.has(day)?'Mark as not read':'Mark as read'} aria-label={done.has(day)?'Mark as not read':'Mark as read'}
            style={{flexShrink:0,width:26,height:26,marginTop:1,borderRadius:7,cursor:'pointer',display:'inline-flex',alignItems:'center',justifyContent:'center',
              background:done.has(day)?T.gF:'transparent',border:`1.5px solid ${done.has(day)?T.gD:T.bd}`,color:T.gT,fontSize:U(14),lineHeight:1,padding:0}}>
            {done.has(day)?'✓':''}
          </button>
        );
        // The whole year in order, today in the middle: days behind you are a
        // scroll up, days ahead a scroll down.
        return (
          <Modal title="Reading Plan" onClose={closeModal} T={T} topSheet={navH} isClosing={modalClosing} hideBack fade
            subHeader={<>
              {/* The title is centred on the row itself, so the reminder on one
                  side and the day count on the other never pull it off centre. */}
              <div style={{position:'relative',display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:7}}>
                {/* Everything but the switch is out of flow, so the row's height is
                    the switch's height whether the time is showing or not — turning
                    the reminder on moves nothing. The time sits in the header's own
                    bottom padding, well clear of the centred title above it. */}
                <div style={{position:'relative',display:'inline-flex',flex:'1 1 0',minWidth:0}}>
                  {Capacitor.isNativePlatform()&&(<>
                    {/* Switching on asks for the time first, and only switches on if
                        a time is actually chosen. The invisible native picker this
                        replaces had to guess at that, since accepting its wheel
                        unchanged fires no event at all. */}
                    <button type="button" disabled={planRemindBusy}
                      onClick={()=>{
                        if(planRemind.on){planRemindOff();return;}
                        setTimePicker({value:planRemind.time,onSet:planRemindOn});
                      }}
                      style={{display:'flex',alignItems:'center',gap:7,background:'transparent',border:'none',borderRadius:7,color:planRemind.on?T.gT:T.dim,fontFamily:FB,fontSize:U(12),padding:'5px 2px',cursor:'pointer',opacity:planRemindBusy?0.5:1,whiteSpace:'nowrap'}}>
                      <span style={{width:14,height:14,borderRadius:4,border:`1.5px solid ${planRemind.on?T.gD:T.bd}`,background:planRemind.on?T.gD:'transparent',color:T.bg,fontSize:UL(9),lineHeight:1,display:'inline-flex',alignItems:'center',justifyContent:'center'}}>{planRemind.on?'\u2713':''}</span>
                      Reminder
                    </button>
                    {planRemind.on&&(
                      /* The time reads as a plain note above the switch, and opens the
                         picker again to change it. */
                      <button type="button" onClick={()=>setTimePicker({value:planRemind.time,onSet:planRemindOn})}
                        style={{position:'absolute',left:2,bottom:'100%',marginBottom:1,background:'none',border:'none',outline:'none',padding:0,margin:0,cursor:'pointer',
                          fontFamily:FS,fontSize:U(10.5),lineHeight:1,letterSpacing:'0.1em',color:T.gM,whiteSpace:'nowrap'}}>
                        {planTimeLabel(planRemind.time)}
                      </button>
                    )}
                  </>)}
                </div>
                <span style={{flex:'0 1 auto',minWidth:0,textAlign:'center',overflow:'hidden',textOverflow:'ellipsis',fontFamily:FS,fontSize:U(11.5),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,whiteSpace:'nowrap',pointerEvents:'none'}}>The Bible in a year</span>
                <span style={{flex:'1 1 0',textAlign:'right',fontFamily:FB,fontSize:U(13),color:T.dim,whiteSpace:'nowrap'}}>{done.size} of {PLAN_DAYS} days</span>
              </div>
              <div style={{height:4,background:T.bgSec,borderRadius:2,overflow:'hidden'}}>
                <div style={{width:`${pct}%`,height:'100%',background:T.gD,transition:'width .25s'}}/>
              </div>
              {planRemindMsg&&(
                <div style={{fontFamily:FB,fontSize:U(12),color:T.ambTxt,marginTop:7,lineHeight:1.5}}>{planRemindMsg}</div>
              )}
            </>}>
            {plan.map(entry=>entry.day===today?(
              <div key={entry.day} ref={planTodayRef}
                style={{background:T.bgSec,border:`1px solid ${T.gD}`,borderRadius:10,padding:'12px 13px',margin:'14px 0'}}>
                <div style={{display:'flex',alignItems:'flex-start',gap:11}}>
                  <Tick day={today}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:FS,fontSize:U(13.5),letterSpacing:'0.1em',textTransform:'uppercase',color:T.gT}}>
                      Today · {planDateLabel(today,planYear)}
                    </div>
                    <Passages day={entry.day}/>
                  </div>
                </div>
              </div>
            ):(
              <div key={entry.day} style={{display:'flex',alignItems:'flex-start',gap:11,padding:'11px 2px',borderTop:`1px solid ${T.bd}`}}>
                <Tick day={entry.day}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:FB,fontSize:U(14),color:done.has(entry.day)?T.dim:T.mut}}>
                    {planDateLabel(entry.day,planYear)}
                  </div>
                  <Passages day={entry.day}/>
                </div>
              </div>
            ))}
          </Modal>
        );
      })()}
      {modal?.type==='audiohelp'&&(
        <Modal title="Adding KJV Audio" onClose={closeModal} T={T} topSheet={navH} isClosing={modalClosing} footer={<SBtn ch="Close" onClick={closeModal} T={T}/>}>
          <div style={{fontFamily:FB,fontSize:U(14),color:T.mut,lineHeight:1.7}}>
            <p style={{margin:'0 0 12px'}}>
              The KJV audio is free from Faith Comes By Hearing. You download it from their
              website, then bring the file back into Scriptorium. The Old and New Testaments
              are two separate downloads — do the whole process once for each.
            </p>
            <div style={{borderLeft:`2px solid ${T.gD}`,paddingLeft:12,margin:'0 0 16px'}}>
              <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:5}}>Why the extra steps</div>
              <div style={{fontFamily:FB,fontSize:U(13),color:T.dim,lineHeight:1.6}}>
                Faith Comes By Hearing give these recordings away freely for your own
                listening, but passing them on to others needs a licence Scriptorium
                doesn't hold. So the audio can't be built into the app — the copy has to
                come from them, to you.
              </div>
            </div>
            <div style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:8,padding:'10px 12px',marginBottom:18}}>
              <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:7}}>The two files</div>
              {[['ENGKJVO1DA.zip','Old Testament','1.7 GB','929 chapters'],
                ['ENGKJVN1DA.zip','New Testament','488 MB','260 chapters']].map(([f,t,sz,ch])=>(
                <div key={f} style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:4,flexWrap:'wrap'}}>
                  <code style={{fontFamily:'ui-monospace,Menlo,monospace',fontSize:U(12),color:T.gT}}>{f}</code>
                  <span style={{fontFamily:FB,fontSize:U(12),color:T.mut}}>{t}</span>
                  <span style={{fontFamily:FB,fontSize:U(12),color:T.dim}}>· {sz} · {ch}</span>
                </div>
              ))}
              <div style={{fontFamily:FB,fontSize:U(12),color:T.dim,lineHeight:1.5,marginTop:7}}>
                The <strong style={{color:T.mut}}>O</strong> and <strong style={{color:T.mut}}>N</strong> in the
                filename are the only difference — O for Old, N for New.
              </div>
            </div>
            <p style={{margin:'0 0 16px',fontSize:U(13),color:T.dim,lineHeight:1.6}}>
              Check you have storage free before you start — the Old Testament is 1.7 GB,
              and you need room for both the download and the audio it unpacks into.
            </p>
            {[
              ['Tap "Download OT File" above','Faith Comes By Hearing opens in your browser. Check the Version box reads "King James Version audio Old Testament" before going on.'],
              ['Fill in the short form','They ask for a first name, last name and email address before the download will start. This is their requirement, not ours.'],
              ['Tick "I\'m not a robot", then tap DOWNLOAD','The tick box sits just above the red DOWNLOAD button, and the button will not work until it is ticked.'],
              ['Wait for it to finish','Leave the browser open while it downloads. Your browser saves it into Files, normally under Downloads. Do not unzip it — Scriptorium needs the .zip exactly as it arrives.'],
              ['Come back here and tap "Import OT File"','In the picker that opens, tap Browse, then Downloads, then ENGKJVO1DA.zip. Scriptorium unpacks the 929 chapters itself; this takes a few minutes.'],
              ['Now do the same for the New Testament','Use the NT buttons and ENGKJVN1DA.zip. Once both show a green tick, audio plays with no connection at all.'],
            ].map(([t,d],i)=>(
              <div key={i} style={{display:'flex',gap:11,marginBottom:13}}>
                <div style={{flexShrink:0,width:23,height:23,borderRadius:12,border:`1px solid ${T.gD}`,color:T.gT,fontFamily:FS,fontSize:U(11),display:'flex',alignItems:'center',justifyContent:'center',marginTop:1}}>{i+1}</div>
                <div style={{minWidth:0}}>
                  <div style={{color:T.gT,fontWeight:600,marginBottom:2}}>{t}</div>
                  <div style={{fontSize:U(13),color:T.dim,lineHeight:1.6}}>{d}</div>
                </div>
              </div>
            ))}
            <p style={{margin:'14px 0 0',fontSize:U(13),color:T.dim,lineHeight:1.6}}>
              Once a Testament shows its green tick you can delete that .zip from the Files
              app to get the space back — Scriptorium has already copied what it needs.
            </p>
          </div>
          {audioHelpVideo&&(
            <div style={{marginTop:22,paddingTop:18,borderTop:`1px solid ${T.bd}`}}>
              <div style={{fontFamily:FS,fontSize:UL(10),letterSpacing:'0.12em',textTransform:'uppercase',color:T.gM,marginBottom:4}}>Watch it done</div>
              <div style={{fontFamily:FB,fontSize:U(12),color:T.dim,marginBottom:9,lineHeight:1.5}}>
                It is a phone recording, so it shows narrow here — use the expand control to fill the screen.
              </div>
              {/* A portrait clip can be tall or wide, not both. Capped so the whole
                  thing is visible at once; fullscreen is there for reading detail. */}
              <video src={audioHelpVideo} controls playsInline preload="metadata"
                onError={()=>setAudioHelpVideo(null)}
                style={{maxHeight:'46vh',maxWidth:'100%',width:'auto',margin:'0 auto',borderRadius:9,display:'block',background:'#000',border:`1px solid ${T.bd}`}}/>
            </div>
          )}
        </Modal>
      )}
      {modal?.type==='reset'&&<ResetConfirmModal T={T} onConfirm={doReset} onCancel={()=>setModal(null)} entryCount={data.entries.length} sectionCount={data.sections.length}/>}
      {confirmDeleteDl&&<ConfirmDialog T={T} danger
        title="Remove offline download?"
        message={`${dlDisplayName(confirmDeleteDl)} will be removed from this device. It keeps working while you have a connection, and you can download it again at any time.${confirmDeleteDl==='strongs'?' Strong\'s takes several minutes to download again.':''}`}
        confirmLabel="Remove" cancelLabel="Keep"
        onConfirm={()=>{const v=confirmDeleteDl;setConfirmDeleteDl(null);doDeleteDownload(v);}}
        onCancel={()=>setConfirmDeleteDl(null)}/>}
      {modal?.type==='help'&&(
        <Modal title="Help & Reference" onClose={closeModal} wide T={T} topSheet={navH} isClosing={modalClosing} footer={<><PBtn ch="Reset to Defaults" onClick={()=>setModal({type:'reset'})} T={T} danger sm/><SBtn ch="Close" onClick={closeModal} T={T}/></>}>
          {(()=>{
            const rdFont=fontFamilyMap[readFontFamily];
            const rdLH=Math.max(1.5,Math.min(readLineHeight,2.2));
            // A reference panel, so it follows Menus & Buttons like every other
            // panel. It took its size from Scripture Size, whose default is 31:
            // clamped at 22 it read large, and at 30 it read enormous. It keeps
            // the reader's font and line spacing, which are about taste.
            const rdSz=U(15);
            const Hdg=({label})=>(
              <div style={{display:'flex',alignItems:'center',gap:10,margin:'22px 0 10px'}}>
                <div style={{fontFamily:FS,fontSize:U(12),letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,minWidth:0}}>{label}</div>
                <div style={{flex:'1 0 16px',height:1,background:T.bd}}/>
              </div>
            );
            const Row=({icon,children})=>(
              <div style={{display:'flex',gap:10,alignItems:'flex-start',marginBottom:9}}>
                <span style={{fontSize:rdSz,flexShrink:0,width:U(22),textAlign:'center',marginTop:1}}>{icon}</span>
                <span style={{fontFamily:rdFont,fontSize:rdSz,color:T.mut,lineHeight:rdLH}}>{children}</span>
              </div>
            );
            const Chip=({children})=>(
              <span style={{display:'inline-flex',alignItems:'center',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:5,padding:'2px 7px',fontFamily:'monospace',fontSize:U(12),color:T.gT,marginRight:6,marginBottom:4}}>{children}</span>
            );
            return(
              <div>
                {/* ── READING ── */}
                <Hdg label="Reading"/>
                <Row icon="✦">
                  <strong style={{color:T.gT}}>Navigate</strong> using the bar at the bottom of the screen — tap the <strong style={{color:T.gT}}>book name</strong> (e.g. Genesis 1) to jump to any book and chapter, or tap <strong style={{color:T.gT}}>CH 2 ›</strong> to move to the next chapter.
                </Row>
                <Row icon="▤">
                  Tap the <strong style={{color:T.gT}}>version label</strong> (e.g. KJV) in the top bar to switch Bible translations.
                </Row>
                <Row icon="⊙">
                  <strong style={{color:T.gT}}>Tap any verse</strong> to select it — it highlights and a toolbar appears at the bottom. Tap again to deselect. You can select multiple verses at once.
                </Row>
                <Row icon="⛶">
                  <strong style={{color:T.gT}}>Fullscreen mode</strong> hides the top navigation bar when you scroll down for distraction-free reading. Scroll back up to reveal it. Enable in <em>Settings → Fullscreen</em>.
                </Row>
                <Row icon="¶">
                  <strong style={{color:T.gT}}>Paragraph Mode</strong> flows verses into continuous paragraphs instead of numbered lines — useful for narrative reading. Enable in <em>Settings → Reading Appearance</em>.
                </Row>
                <Row icon="●">
                  <strong style={{color:T.gT}}>Red Letter</strong> highlights words spoken by Jesus. Enable in <em>Settings → Reading Appearance → Red Letter</em>. Only available on versions with red-letter data.
                </Row>

                {/* ── SEARCH ── */}
                <Hdg label="Search"/>
                <Row icon="⌕">
                  Tap the <strong style={{color:T.gT}}>search icon</strong> in the top bar to search the current version. Results appear as you type, from three letters on, with a running count of the verses and occurrences that matched.
                </Row>
                <Row icon="⚙">
                  The <strong style={{color:T.gT}}>filter bar</strong> sets <strong style={{color:T.gT}}>Scope</strong> — All, OT or NT — and <strong style={{color:T.gT}}>Mode</strong> — All Words, Phrase or Any Word — with Case Sensitive and Partial Match beside them. A reset arrow appears once you change anything. Tap the filter button to pin the bar so it stays put while the results scroll.
                </Row>
                <Row icon="≡">
                  Tap the <strong style={{color:T.gT}}>book name</strong> in the bar above the results to open a wheel and jump to any other book that matched.
                </Row>
                <Row icon="←">
                  Tap the <strong style={{color:T.gT}}>←</strong> in the bar above the results to dismiss them and return to where you were.
                </Row>

                {/* ── VERSE SELECTION & BOOKMARKS ── */}
                <Hdg label="Verse Selection & Bookmarks"/>
                <Row icon="⧉">
                  After selecting one or more verses a toolbar appears at the bottom. Tap <strong style={{color:T.gT}}>Copy</strong> to copy the verse text with its reference formatted for sharing.
                </Row>
                <Row icon="✦">
                  Tap <strong style={{color:T.gT}}>Bookmark</strong> to open the save form — write a note, choose a category, or create a category on the spot. The passage reference becomes the bookmark's title.
                </Row>
                <Row icon="▤">
                  Manage bookmarks in <em>Study → Bookmarks</em>. Each category is a card in its own colour, and <strong style={{color:T.gT}}>Assign Categories</strong> at the top moves bookmarks between them without opening each one.
                </Row>
                <Row icon="▸">
                  With a verse selected, the <strong style={{color:T.gT}}>play button</strong> reads <em>Play from Verse N</em> and starts audio there instead of at the beginning of the chapter.
                </Row>

                {/* ── HIGHLIGHTS ── */}
                <Hdg label="Highlights"/>
                <Row icon="◐">
                  Tap the <strong style={{color:T.gT}}>colour button</strong> beside the verse reference in the bar to highlight the selected verses in one of five colours, or tap <strong style={{color:T.gT}}>Remove</strong> to clear them. A highlight belongs to the version you made it in, so switching versions shows that version's own.
                </Row>
                <Row icon="▤">
                  See every highlight in <em>Study → Highlights</em>, grouped by colour and shown in the words of its version. Filter by colour or by version, and tap <strong style={{color:T.gT}}>Open</strong> to go straight to the verse.
                </Row>

                {/* ── READING PLANS ── */}
                <Hdg label="Reading Plans"/>
                <Row icon="✦">
                  Tap <strong style={{color:T.gT}}>Read</strong> in the bottom bar while you are already in the Read tab to open the <strong style={{color:T.gT}}>reading plan</strong>. Each day lists its passages with a checkbox to mark the day read.
                </Row>
                <Row icon="▸">
                  Tap any passage to jump to it. That day's readings then float above the bottom bar as you read: the passage you are in is lit, tapping another jumps there, and the checkbox marks the day without taking the row away.
                </Row>
                <Row icon="✕">
                  Close the row with its <strong style={{color:T.gT}}>✕</strong> whether or not you finished — marking the day read and putting the row away are separate. It stays until you close it or close the app.
                </Row>

                {/* ── AUDIO ── */}
                <Hdg label="Audio"/>
                <Row icon="▸">
                  Tap the <strong style={{color:T.gT}}>play button</strong> (bottom-right corner in the Read tab) to start audio for the current chapter. The button expands to show the current verse number as it plays.
                </Row>
                <Row icon="♪">
                  Audio uses <strong style={{color:T.gT}}>Faith Comes By Hearing (FCBH)</strong> streaming where available — professional narration matched to the text. Falls back to your device's built-in text-to-speech when FCBH isn't available for a version.
                </Row>
                <Row icon="⋯">
                  Change the audio source, voice, and playback speed in <em>Settings → Audio Playback</em>. Voice selection only applies when using text-to-speech.
                </Row>
                <Row icon="↓">
                  Import local KJV MP3 audio files (Old or New Testament) in <em>Settings → Audio Playback → KJV Local Audio</em> for fully offline playback.
                </Row>

                {/* ── STUDY / COMPARE ── */}
                <Hdg label="Study & Compare"/>
                <Row icon="✦">
                  The <strong style={{color:T.gT}}>Study tab</strong> is your personal Bible comparison workspace. It stores entries organized into sections, each with a verse reference, notes, and side-by-side version comparisons.
                </Row>
                <Row icon="＋">
                  Tap <strong style={{color:T.gT}}>Add Entry</strong> inside any section to create a new comparison entry. Choose a verse reference, select an issue type, add notes, and record how each version renders the passage.
                </Row>
                <Row icon="⚑">
                  Each entry version can be marked with a <strong style={{color:T.gT}}>status</strong> — Reference, Faithful, Questionable, or Mistranslation — to track translation accuracy at a glance.
                </Row>
                <Row icon="▤">
                  Tap <strong style={{color:T.gT}}>Read</strong> on any entry to jump directly to that passage in the reading view.
                </Row>

                {/* ── STRONG'S NUMBERS ── */}
                <Hdg label="Strong's Numbers (KJV only)"/>
                <Row icon="ℍ">
                  Enable via the <strong style={{color:T.gT}}>Strong's toggle</strong> in Settings. Requires the <strong style={{color:T.gT}}>KJV</strong> version to be selected.
                </Row>
                <Row icon="﹏">
                  Every word gets a <strong style={{color:T.gT}}>dotted underline</strong> linking it to its original Hebrew or Greek root. Words sharing one root are grouped under a single continuous underline — e.g. "Let there be" is one phrase under one Hebrew word.
                </Row>
                <Row icon="⊙">
                  <strong style={{color:T.gT}}>Double-tap or press and hold</strong> any underlined word or phrase to open a popup showing the Strong's number, original word, transliteration, pronunciation, short definition, and full lexical entry.
                </Row>
                <Row icon="✓">
                  The full concordance is included with the app, so lookups work with no connection from the moment you install it — 14,197 Hebrew and Greek entries, plus the word-by-word mapping behind the underlines and every KJV occurrence.
                </Row>

                {/* ── COMMENTARIES ── */}
                <Hdg label="Commentaries"/>
                <Row icon="¶">
                  <strong style={{color:T.gT}}>Commentaries</strong> in Study opens the chapter you are reading in the <strong style={{color:T.gT}}>Treasury of Scripture Knowledge</strong>: an overview of the chapter, then each verse's key words with the passages that explain them. Select a verse first and it opens at that verse.
                </Row>
                <Row icon="⊙">
                  Tap any reference to read it without leaving the page, and <strong style={{color:T.gT}}>Go to passage</strong> to open it in Read. <strong style={{color:T.gT}}>Reciprocal</strong>, under a verse, lists the verses that point back to it.
                </Row>
                <Row icon="＋">
                  Your own e-Sword commentaries (.cmti) can be imported from the menu under the commentary's name, or from Other Resources. They stay on your device.
                </Row>
                <Row icon="✓">
                  The Treasury is included with the app and works with no connection.
                </Row>

                {/* ── WEBSTER'S 1828 ── */}
                <Hdg label="Webster's 1828 Dictionary"/>
                <Row icon="W">
                  Access the full <strong style={{color:T.gT}}>Webster's 1828 American Dictionary</strong> from the Study tab. Search any English word for its historical definition — written in the same era as many classic Bible translations.
                </Row>
                <Row icon="✓">
                  All 107,793 entries are included with the app and work with no connection.
                </Row>

                {/* ── ATLAS & CHARTS ── */}
                <Hdg label="Atlas &amp; Charts"/>
                <Row icon="⛶">
                  <strong style={{color:T.gT}}>Maps</strong> in the Study tab holds seventeen engraved plates, running in the order the story does — from the descendants of Noah to the journeys of Christ and the apostles. Pinch to zoom; the scans hold their detail well past the point the old ones blurred.
                </Row>
                <Row icon="▦">
                  <strong style={{color:T.gT}}>Charts</strong> holds Clarence Larkin's plates from <em>Dispensational Truth</em> (1918), grouped by section. Tap any chart to open it full screen and zoom.
                </Row>
                <Row icon="＋">
                  Both screens take your own images as well — imported maps and charts sit above the built-in ones and stay on your device.
                </Row>

                {/* ── OFFLINE DATA ── */}
                <Hdg label="Offline Data"/>
                <Row icon="▤">
                  <strong style={{color:T.gT}}>Bible versions</strong> can be downloaded for fully offline use. Go to <em>Settings → Offline Data → Manage Bible Versions</em> and tap the download arrow next to any version.
                </Row>
                <Row icon="✓">
                  A version marked <strong style={{color:T.greenTxt||'#62c484'}}>✓ Offline</strong> is fully cached and works with no internet. Tap the button again to remove the offline copy and free up storage.
                </Row>

                {/* ── SETTINGS REFERENCE ── */}
                <Hdg label="Settings Reference"/>
                {[
                  ['Accent Color','Changes the highlight color throughout the app — underlines, active borders, selected verse glow, and buttons. Pick a preset or mix your own.'],
                  ['Scripture Size','The size of the verse text, from 13 to 60.'],
                  ['Menus & Buttons','Scales everything else — navigation, labels, buttons, sheets and panels — from 85% to 150%. Set separately from Scripture Size, so large verses can sit in a compact interface, or the reverse.'],
                  ['Line Spacing','Controls vertical space between lines of text (Tight → Wide).'],
                  ['Font','Serif (Cormorant Garamond), Sans-Serif (Source Sans 3), or Monospace (Inconsolata).'],
                  ['Alignment','Left-aligned or fully justified text.'],
                  ['Verse Numbers','Superscript (small raised), Inline (same size as body text), or Hidden.'],
                  ['Paragraph Mode','Removes verse-by-verse line breaks and flows text as continuous paragraphs.'],
                  ['Red Letter','Colors words of Jesus red. Only on versions that include red-letter data.'],
                  ["Strong's",'Activates Hebrew/Greek root underlines on every word. KJV only.'],
                  ['Fullscreen','Auto-hides the top navigation bar when scrolling down.'],
                  ['Theme','Light or Dark mode. Follows your system setting by default.'],
                  ['Reset Appearance Settings','Puts everything in Reading Appearance back to its default, including both size sliders.'],
                ].map(([k,v])=>(
                  <div key={k} style={{display:'flex',flexWrap:'wrap',columnGap:10,rowGap:2,alignItems:'baseline',marginBottom:8}}>
                    <span style={{fontFamily:FS,fontSize:U(12),color:T.gT,letterSpacing:'0.06em',flexShrink:0,width:U(124),fontWeight:600}}>{k}</span>
                    <span style={{fontFamily:rdFont,fontSize:rdSz,color:T.dim,lineHeight:rdLH,flex:'1 1 180px',minWidth:0}}>{v}</span>
                  </div>
                ))}

                {/* ── SHORTCUTS ── */}
                <Hdg label="Gestures & Shortcuts"/>
                <div style={{display:'flex',flexWrap:'wrap',gap:'6px 0',alignItems:'center',fontFamily:rdFont,fontSize:rdSz,color:T.mut}}>
                  <Chip>Swipe down</Chip><span style={{marginRight:16}}>Dismiss any bottom sheet or modal</span>
                  <Chip>Tap verse</Chip><span style={{marginRight:16}}>Select it — tap another to add it to the selection</span>
                  <Chip>Tap again</Chip><span style={{marginRight:16}}>Deselect that verse</span>
                  <Chip>Hold a word</Chip><span>Open Strong's for it</span>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}

      {modal?.type==='about'&&(
        <Modal title="About & Legal" onClose={closeModal} wide T={T} topSheet={navH} isClosing={modalClosing} footer={<SBtn ch="Close" onClick={closeModal} T={T}/>}>
          {(()=>{
            const Hdg=({label})=>(
              <div style={{display:'flex',alignItems:'center',gap:10,margin:'22px 0 10px'}}>
                <div style={{fontFamily:FS,fontSize:U(12),letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,minWidth:0}}>{label}</div>
                <div style={{flex:'1 0 16px',height:1,background:T.bd}}/>
              </div>
            );
            const P=({children})=>(
              <p style={{fontFamily:FB,fontSize:U(14),color:T.mut,lineHeight:1.75,marginBottom:10,marginTop:0}}>{children}</p>
            );
            const Li=({children})=>(
              <div style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:7}}>
                <span style={{color:T.gM,flexShrink:0,marginTop:3,fontSize:U(11)}}>◆</span>
                <span style={{fontFamily:FB,fontSize:U(14),color:T.mut,lineHeight:1.7}}>{children}</span>
              </div>
            );
            return(
              <div>

                {/* APP */}
                <Hdg label="About Scriptorium"/>
                <P>Scriptorium is a Bible study and comparison tool designed for in-depth textual research, supporting multiple translations with verse-level comparison, manuscript notes, and original-language cross-referencing.</P>
                <P>All renderings in this app should be verified against printed, authoritative texts. Scriptorium provides a study aid — it is not a substitute for careful scholarship or printed editions.</P>

                {/* COPYRIGHT */}
                <Hdg label="Copyright Disclaimer"/>
                <P>The Scriptorium application, its interface, design, and original code are copyright © {new Date().getFullYear()} Scriptorium. All rights reserved.</P>
                <P>Bible translations, lexicons, and dictionaries included in this app are either in the public domain or used in accordance with their respective license terms. No portion of copyrighted version texts may be reproduced beyond personal study use without permission from the copyright holder.</P>

                {/* PUBLIC DOMAIN */}
                <Hdg label="Public Domain Works"/>
                <Li><strong style={{color:T.gT}}>King James Version (KJV)</strong> — First published 1611. Public domain in the United States and most jurisdictions worldwide. In the United Kingdom it remains Crown Copyright and is reproduced under the terms of the Cambridge University Press licence.</Li>
                <Li><strong style={{color:T.gT}}>Strong's Hebrew & Greek Lexicon</strong> — James Strong, <em>Exhaustive Concordance of the Bible</em> (1890). Public domain.</Li>
                <Li><strong style={{color:T.gT}}>Webster's 1828 American Dictionary</strong> — Noah Webster (1828). Public domain.</Li>

                {/* TSKe -- its licence requires this notice with every copy */}
                <Hdg label="Treasury of Scripture Knowledge"/>
                <P><strong style={{color:T.gT}}>The Treasury of Scripture Knowledge, Enhanced (TSKe)</strong>, v1.85 with Self References, by Timothy S. Morton of Bible Analyzer. The original nineteenth-century Treasury of Scripture Knowledge, on which it is built, is in the public domain.</P>
                {TSKE_NOTICE.map((t,i)=><P key={i}>{t}</P>)}
                <P>As the licence asks, this edition is offered free and in an open format: plain JSON, at <span style={{color:T.gT,overflowWrap:'anywhere'}}>brockigordon1611.github.io/Scriptorium/bundled/tske.json</span></P>

                {/* THIRD-PARTY VERSIONS */}
                <Hdg label="Third-Party Bible Versions"/>
                <Li><strong style={{color:T.gT}}>Reina-Valera Gómez (RVG)</strong> — © Dr. Humberto Gómez Caballero. Licensed under Creative Commons CC BY-NC-ND 3.0. Used for personal, non-commercial study only. For commercial or distribution licensing, contact the copyright holder directly.</Li>
                <Li><strong style={{color:T.gT}}>Purificada 1602 (1602P)</strong> — © 2007–2024 Iglesia Bautista Bíblica de la Gracia, Monterrey, Mexico. Textual restoration based on the 1602 Reina-Valera. Used for study and research purposes without modification.</Li>

                {/* MAPS & CHARTS */}
                <Hdg label="Maps &amp; Charts"/>
                <Li><strong style={{color:T.gT}}>Scripture Atlas</strong> — The seventeen plates are engraved maps from historical Bible atlases, long out of copyright by age. The high-resolution scans are from the David Rumsey Map Collection, retrieved through its Internet Archive mirror, and are reproduced here for personal, non-commercial study.</Li>
                <Li><strong style={{color:T.gT}}>Larkin's Charts</strong> — Clarence Larkin, <em>Dispensational Truth, or God's Plan and Purpose in the Ages</em> (1918). Public domain.</Li>

                {/* AUDIO */}
                <Hdg label="Audio Attribution"/>
                <Li><strong style={{color:T.gT}}>Faith Comes By Hearing (FCBH)</strong> — Streamed and downloadable audio provided by Faith Comes By Hearing (Hosanna/FCBH), Albuquerque, NM. Audio content is copyright © its respective rights holders and is streamed for personal, non-commercial listening only. Visit <span style={{color:T.gT,overflowWrap:'anywhere'}}>www.faithcomesbyhearing.com</span> for more information.</Li>
                <Li><strong style={{color:T.gT}}>Browser Text-to-Speech</strong> — Synthesized audio is generated by your device's built-in speech engine and is not derived from any recorded performance.</Li>

                {/* USER CONTENT */}
                <Hdg label="Content You Add"/>
                <P>Scriptorium can import Bible modules (e-Sword .bblx and .bbli, MyBible .SQLite3), e-Sword commentaries (.cmti), maps, charts and local audio from your own device. Imported commentaries stay on the device they were imported on. Imported verse text is written to this device only and is never uploaded — the app registers nothing about it beyond its name, language and verse count, so that the same version can be recognised when you sign in elsewhere.</P>
                <P>You are responsible for holding the rights to anything you import, and for observing the licence of any version you add. Imported content is never shared with other users or redistributed by this app.</P>

                {/* ATTRIBUTION */}
                <Hdg label="Attribution Requirements"/>
                <P>If you quote or share content produced with the aid of this app, please attribute the Bible version used (e.g., "KJV", "RVG") and verify the text against a printed edition. For copyrighted versions, follow the attribution guidelines set by each version's copyright holder.</P>

                {/* DISCLAIMER */}
                <Hdg label="Disclaimer of Warranties"/>
                <P>Scriptorium is provided "as is" without warranty of any kind, express or implied. While every effort is made to ensure textual accuracy, no guarantee is made that verse text, Strong's data, or dictionary entries are free from error. Users are responsible for verifying all content against authoritative printed sources.</P>
                <P>This app does not store, transmit, or sell personal study data beyond what is required for account sync. The full Privacy Policy is at <span style={{color:T.gT,overflowWrap:'anywhere'}}>brockigordon1611.github.io/Scriptorium/docs/privacy.html</span>.</P>

                {/* VERSION */}
                <div style={{marginTop:28,paddingTop:16,borderTop:`1px solid ${T.bdS}`,display:'flex',alignItems:'center',gap:12}}>
                  <div style={{flex:1,height:1,background:T.accentLine}}/>
                  <span style={{fontFamily:FS,fontSize:U(11),letterSpacing:'0.2em',color:T.gD,textTransform:'uppercase',fontWeight:500}}>To God Alone Be the Glory</span>
                  <div style={{flex:1,height:1,background:T.accentLine}}/>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}

      <UndoToast ud={undo} onUndo={doUndo} onDismiss={dismissUndo} T={T}/>

      {/* ── Custom Color Picker Modal ── */}
      {customPickerOpen&&(
        <div onClick={()=>{setAccent(pickerOrigRef.current.accent);setCustomAccentHex(pickerOrigRef.current.hex);setCustomPickerOpen(false);}}
          style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.62)',zIndex:9000,display:'flex',alignItems:'center',justifyContent:'center',padding:24,backdropFilter:'blur(4px)',WebkitBackdropFilter:'blur(4px)'}}>
          <div onClick={e=>e.stopPropagation()}
            style={{background:T.bgCard,borderRadius:20,padding:'22px 20px 20px',width:'100%',maxWidth:340,boxShadow:`0 16px 56px rgba(0,0,0,0.65),0 0 0 1px ${T.bd}`}}>

            {/* Header */}
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
              <span style={{fontFamily:FS,fontSize:U(13),fontWeight:600,color:T.gT,letterSpacing:'0.1em',textTransform:'uppercase'}}>Custom Color</span>
              <NavIconBtn ch="✕" T={T} title="Close"
                onClick={()=>{setAccent(pickerOrigRef.current.accent);setCustomAccentHex(pickerOrigRef.current.hex);setCustomPickerOpen(false);}}/>
            </div>

            {/* Color preview swatch */}
            <div style={{height:80,borderRadius:14,background:`linear-gradient(135deg,${hslToHex(pickerH,pickerS,Math.min(pickerL+15,95))},${hslToHex(pickerH,pickerS,pickerL)},${hslToHex(pickerH,pickerS,Math.max(pickerL-15,5))})`,marginBottom:18,boxShadow:`0 4px 20px ${hslToHex(pickerH,pickerS,pickerL)}66,inset 0 1px 0 rgba(255,255,255,0.15)`,display:'flex',alignItems:'flex-end',justifyContent:'flex-end',padding:'8px 10px'}}>
              <span style={{fontFamily:'monospace',fontSize:U(12),color:'rgba(255,255,255,0.85)',fontWeight:600,letterSpacing:'0.08em',textShadow:'0 1px 4px rgba(0,0,0,0.6)',background:'rgba(0,0,0,0.25)',borderRadius:6,padding:'3px 7px'}}>{hslToHex(pickerH,pickerS,pickerL).toUpperCase()}</span>
            </div>

            {/* Hue */}
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:U(12),color:T.mut}}>Hue</span>
                <span style={{fontFamily:'monospace',fontSize:U(11),color:T.gM}}>{pickerH}°</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="360" value={pickerH}
                onChange={e=>{const h=Number(e.target.value);setPickerH(h);const hex=hslToHex(h,pickerS,pickerL);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))`}}/>
            </div>

            {/* Saturation */}
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:U(12),color:T.mut}}>Saturation</span>
                <span style={{fontFamily:'monospace',fontSize:U(11),color:T.gM}}>{pickerS}%</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="100" value={pickerS}
                onChange={e=>{const s=Number(e.target.value);setPickerS(s);const hex=hslToHex(pickerH,s,pickerL);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(${pickerH},0%,${pickerL}%),hsl(${pickerH},100%,${pickerL}%))`}}/>
            </div>

            {/* Lightness */}
            <div style={{marginBottom:22}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:U(12),color:T.mut}}>Lightness</span>
                <span style={{fontFamily:'monospace',fontSize:U(11),color:T.gM}}>{pickerL}%</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="100" value={pickerL}
                onChange={e=>{const l=Number(e.target.value);setPickerL(l);const hex=hslToHex(pickerH,pickerS,l);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(${pickerH},${pickerS}%,0%),hsl(${pickerH},${pickerS}%,50%),hsl(${pickerH},${pickerS}%,100%))`}}/>
            </div>

            {/* Buttons */}
            <div style={{display:'flex',gap:8}}>
              <button type="button" onClick={()=>{setAccent(pickerOrigRef.current.accent);setCustomAccentHex(pickerOrigRef.current.hex);setCustomPickerOpen(false);}}
                style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.dim,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'11px 0',cursor:'pointer'}}>
                Cancel
              </button>
              <button type="button" onClick={()=>setCustomPickerOpen(false)}
                style={{flex:2,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:9,color:T.gT,fontFamily:FS,fontSize:U(11),letterSpacing:'0.08em',padding:'11px 0',cursor:'pointer',fontWeight:600}}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}



export default App;
