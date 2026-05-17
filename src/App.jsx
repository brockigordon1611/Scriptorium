import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';



/* ══════════════════════════════════════════════════════════════
   SCRIPTORIUM v2  ✦  Bible Study & Comparison Tool
   "The words of the LORD are pure words: as silver tried
    in a furnace of earth, purified seven times." — Psalm 12:6
   ══════════════════════════════════════════════════════════════ */

// ── Supabase config ───────────────────────────────────────
const SUPA_URL  = "https://garuwsjczcptykehgjdx.supabase.co";
const SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcnV3c2pjemNwdHlrZWhnamR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNzU3ODYsImV4cCI6MjA4ODY1MTc4Nn0.AL6IpnRaOAs8EQJSpnS0Ep4O9WD85RFU0xIm2ipXixE";

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
async function sbFrom(table, token) {
  const hdrs = sbHeaders(token);
  const base = `${SUPA_URL}/rest/v1/${table}`;
  return {
    async select(cols, filters={}, opts={}) {
      let url = `${base}?select=${encodeURIComponent(cols||'*')}`;
      for (const [k,v] of Object.entries(filters)) url += `&${k}=eq.${encodeURIComponent(v)}`;
      if (opts.order) url += `&order=${opts.order}`;
      if (opts.limit) url += `&limit=${opts.limit}`;
      const r = await fetch(url, { headers: hdrs });
      const d = await r.json();
      return { data: Array.isArray(d)?d:[], error: r.ok?null:d };
    },
    async insert(rows) {
      const body = Array.isArray(rows)?rows:[rows];
      const r = await fetch(base, { method:'POST', headers:{...hdrs,'Prefer':'return=representation'}, body:JSON.stringify(body) });
      const d = await r.json();
      return { data: Array.isArray(d)?d:[d], error: r.ok?null:d };
    },
    async upsert(rows) {
      const body = Array.isArray(rows)?rows:[rows];
      const r = await fetch(base, { method:'POST', headers:{...hdrs,'Prefer':'return=representation,resolution=merge-duplicates'}, body:JSON.stringify(body) });
      const d = await r.json();
      return { data: Array.isArray(d)?d:[d], error: r.ok?null:d };
    },
    async update(vals, filters={}) {
      let url = `${base}?`;
      for (const [k,v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;
      const r = await fetch(url, { method:'PATCH', headers:{...hdrs,'Prefer':'return=representation'}, body:JSON.stringify(vals) });
      const d = await r.json();
      return { data: Array.isArray(d)?d:[], error: r.ok?null:d };
    },
    async delete(filters={}) {
      let url = `${base}?`;
      for (const [k,v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;
      const r = await fetch(url, { method:'DELETE', headers:hdrs });
      return { error: r.ok?null:await r.json() };
    },
  };
}

async function sbRpc(func, params, token) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${func}`, {
    method:'POST', headers: sbHeaders(token), body: JSON.stringify(params)
  });
  const d = await r.json();
  return { data: d, error: r.ok?null:d };
}

// ── Auth ──────────────────────────────────────────────────
const authListeners = [];
const Auth = {
  async getSession() {
    try {
      const raw = localStorage.getItem(SB_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.expires_at && Date.now()/1000 > s.expires_at - 60) {
        const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
          method:'POST', headers: sbHeaders(null), body: JSON.stringify({ refresh_token: s.refresh_token })
        });
        if (r.ok) { const ns = await r.json(); saveSession(ns); return ns; }
        saveSession(null); return null;
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
  onAuthChange(fn) { authListeners.push(fn); return () => { const i=authListeners.indexOf(fn); if(i>=0) authListeners.splice(i,1); }; }
};


// ══════════════════════════════════════════════════════════
//  LOCAL-FIRST: IndexedDB Bible text cache
// ══════════════════════════════════════════════════════════
const IDB_NAME='scriptorium';
const IDB_VER=2;
let _idbInst=null;

function idbOpen(){
  if(_idbInst)return Promise.resolve(_idbInst);
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(IDB_NAME,IDB_VER);
    req.onupgradeneeded=e=>{
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
    };
    req.onsuccess=e=>{_idbInst=e.target.result;resolve(_idbInst);};
    req.onerror=e=>reject(e.target.error);
  });
}
function _idbReq(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});}

// ── Bible verses ──────────────────────────────────────────
async function idbGetChapterLocal(versionId,bookNum,chapter){
  const db=await idbOpen();
  const rows=await _idbReq(db.transaction('verses','readonly').objectStore('verses').index('by_chapter').getAll([versionId,bookNum,chapter]));
  return rows.sort((a,b)=>a.verse-b.verse);
}
async function idbPutVerses(versionId,rows){
  const db=await idbOpen();
  const tx=db.transaction('verses','readwrite');
  const st=tx.objectStore('verses');
  for(const r of rows)st.put({pk:`${versionId}|${r.book_num}|${r.chapter}|${r.verse}`,version_id:versionId,book_num:r.book_num,chapter:r.chapter,verse:r.verse,text:r.text});
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
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
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}
async function idbClearStrongs(){
  const db=await idbOpen();
  const tx=db.transaction('strongs_lex','readwrite');
  tx.objectStore('strongs_lex').clear();
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
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
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}
async function idbClearWebster(){
  const db=await idbOpen();
  const tx=db.transaction('webster','readwrite');
  tx.objectStore('webster').clear();
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}

// ── Meta / download flags ─────────────────────────────────
async function idbGetMeta(key){try{const db=await idbOpen();const r=await _idbReq(db.transaction('meta','readonly').objectStore('meta').get(key));return r?.value;}catch{return undefined;}}
async function idbPutMeta(key,value){const db=await idbOpen();const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({key,value});return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});}
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
  await new Promise((res,rej)=>{
    const req=st.openCursor(range);
    req.onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}};
    tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);
  });
}

// ── Generic batch downloader ──────────────────────────────
async function _batchDownload({table,select,filter,order,putFn,dlKey,total:initTotal,onProgress,signal}){
  const BATCH=1000;let offset=0;let total=initTotal||0;
  onProgress&&onProgress(0,total);
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
    await putFn(rows);
    offset+=rows.length;
    onProgress&&onProgress(offset,total);
    if(rows.length<BATCH)break;
  }
  await idbPutMeta(`dl:${dlKey}`,true);
}

async function downloadVersionLocally(versionId,onProgress,signal){
  await _batchDownload({table:'bible_verses',select:'book_num,chapter,verse,text',filter:`version_id=eq.${encodeURIComponent(versionId)}`,order:'book_num.asc,chapter.asc,verse.asc',putFn:rows=>idbPutVerses(versionId,rows),dlKey:versionId,total:31102,onProgress,signal});
}
async function downloadStrongsLocally(onProgress,signal){
  await idbPutMeta('dl:strongs',false);
  await idbClearStrongs();
  await _batchDownload({table:'strongs_lexicon',select:'strongs_number,original_word,transliteration,pronunciation,language,short_def,full_def,kjv_usage',order:'strongs_number.asc',putFn:idbPutStrongsEntries,dlKey:'strongs',total:14197,onProgress,signal});
}
async function downloadWebsterLocally(onProgress,signal){
  await idbPutMeta('dl:webster',false);
  await idbClearWebster();
  await _batchDownload({table:'webster_1828',select:'word,pos,definitions',order:'word.asc',putFn:idbPutWebsterEntries,dlKey:'webster',total:107793,onProgress,signal});
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
  {n:49,name:'Ephesians',nameES:'Efesios',v:[23,22,21,28,20,12]},
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
const fontFamilyMap={serif:FB,sans:"'Inter','Segoe UI',system-ui,sans-serif",mono:"'JetBrains Mono','Fira Code','Courier New',monospace"};

const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,500&family=Cinzel:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:var(--ac-scrollbar,#3a3020);border-radius:10px;}
mark.sch{background:var(--ac-mark,rgba(200,168,78,0.22));color:inherit;border-radius:2px;padding:0 2px;}
.hov-card{transition:border-color .3s,box-shadow .3s,transform .3s;}
.hov-card:hover{border-color:var(--ac-bd,#38332a)!important;box-shadow:0 6px 28px rgba(0,0,0,0.3)!important;transform:translateY(-1px);}
.s-btn{transition:all .2s;cursor:pointer;}
.s-ghost:hover{background:var(--ac-ghost-bg,rgba(200,168,78,0.09))!important;border-color:var(--ac-ghost-bd,rgba(200,168,78,0.3))!important;}
.s-tbtn:hover{border-color:var(--ac-tbtn-bd,rgba(200,168,78,0.5))!important;background:var(--ac-tbtn-bg,rgba(200,168,78,0.06))!important;}
.s-danger:hover{border-color:#aa2828!important;color:#e05555!important;background:rgba(180,30,30,0.12)!important;}
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
.modal-in{animation:modalIn .28s cubic-bezier(0.34,1.4,0.64,1) both;}
.section-enter{animation:fadeUp .4s cubic-bezier(0.34,1.2,0.64,1) both;}
.text-reveal{animation:textReveal .35s ease-out both;}
.stagger-1{animation-delay:.05s;}.stagger-2{animation-delay:.1s;}.stagger-3{animation-delay:.15s;}.stagger-4{animation-delay:.2s;}.stagger-5{animation-delay:.25s;}
.gold-shimmer{background:linear-gradient(90deg,transparent,var(--ac-shimmer,rgba(200,168,78,0.12)),transparent);background-size:200% 100%;animation:shimmer 3s ease-in-out infinite;}
.breathe{animation:breathe 2.5s ease-in-out infinite;}
.spinner{width:18px;height:18px;border:2px solid var(--ac-spin-ring,rgba(200,168,78,0.2));border-top-color:var(--ac-spin-top,#c8a84e);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:middle;}
.reading-verse:hover{background:var(--ac-verse-hover,rgba(200,168,78,0.05));border-radius:4px;}
input:focus,select:focus,textarea:focus{border-color:var(--ac-input-bd,rgba(200,168,78,0.27))!important;box-shadow:0 0 0 2px var(--ac-input-sh,rgba(200,168,78,0.08));}
/* ── Mobile overrides (≤915px) ── */
@media(max-width:915px){
  .hide-mobile{display:none!important;}
  .full-mobile{width:100%!important;}
  .show-mobile{display:flex!important;}
  /* Scripture text: bigger, edge-to-edge */
  /* line-height now controlled by readLineHeight state */
  .read-area{padding-bottom:80px!important;scrollbar-width:none;-ms-overflow-style:none;}
  .read-area::-webkit-scrollbar{display:none;}
  .read-scrollbar{position:fixed;right:3px;width:3px;border-radius:2px;background:rgba(180,160,100,0.5);pointer-events:none;z-index:155;opacity:0;transition:opacity .4s ease;}
  .read-scrollbar.visible{opacity:1;transition:opacity .05s ease;}
  .slide-down-sheet>div:first-child{scrollbar-width:none;-ms-overflow-style:none;}
  .slide-down-sheet>div:first-child::-webkit-scrollbar{display:none;}
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
}
@media(max-width:915px){
}
@media(min-width:916px){
  .show-mobile{display:none!important;}
  .app-header{height:50px!important;padding:5px 10px 0!important;box-sizing:border-box!important;}
  .app-header-row{height:100%!important;}
  .read-scrollbar{position:fixed;right:3px;width:3px;border-radius:2px;background:rgba(180,160,100,0.5);pointer-events:none;z-index:155;opacity:0;transition:opacity .4s ease;visibility:hidden;}
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
function hl(text,q,opts){if(!text)return'';const plain=text.replace(/<[^>]+>/g,'');if(!q)return esc(plain);const cs=opts&&opts.caseSensitive;const words=(opts&&opts.mode&&opts.mode!=='phrase')?q.split(/\s+/).filter(Boolean):[q];let out=esc(plain);words.forEach(w=>{const pat=w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const bounded=(opts&&opts.partial===false)?`\\b${pat}\\b`:pat;const rx=new RegExp(`(${bounded})`,cs?'g':'gi');out=out.replace(rx,'<mark class="sch">$1</mark>');});return out;}
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
function localAudioUrl(bookNum,chapter){const{folder,stem}=localAudioStem(bookNum,chapter);return`/audio/${folder}/KJV%20Reg/${stem}.mp3`;}
function localTimestampUrl(bookNum,chapter){const{folder,stem}=localAudioStem(bookNum,chapter);return`/timestamps/${folder}/${stem}.json`;}
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
    const mapped=posMap[wordIdx+1];
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
  if(r.data?.length)return r.data[0];
  const ins=await t.insert({user_id:userId,title:'My Study'});
  return ins.data?.[0]||null;
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
async function dbLoadBookmarks(userId){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.select('*',{user_id:userId},{order:'created_at.desc'});return r.data||[];}
async function dbAddBookmark(userId,{versionId,bookNum,chapter,verse,label,categoryId,note}){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.insert({user_id:userId,version_id:versionId,book_num:bookNum,chapter,verse:verse||null,label:label||null,category_id:categoryId||null,note:note||null});return r.data?.[0];}
async function dbUpdateBookmark(id,{note,categoryId,label}){const token=getToken();const t=await sbFrom('bookmarks',token);const patch={};if(note!==undefined)patch.note=note||null;if(categoryId!==undefined)patch.category_id=categoryId||null;if(label!==undefined)patch.label=label||null;await t.update(patch,{id});}
async function dbDeleteBookmark(id){const token=getToken();const t=await sbFrom('bookmarks',token);await t.delete({id});}
async function dbLoadCategories(userId){const token=getToken();const t=await sbFrom('bookmark_categories',token);const r=await t.select('*',{user_id:userId},{order:'sort_order.asc,created_at.asc'});return r.data||[];}
async function dbAddCategory(userId,{name,color}){const token=getToken();const t=await sbFrom('bookmark_categories',token);const r=await t.insert({user_id:userId,name,color:color||'#62c484'});return r.data?.[0];}
async function dbUpdateCategory(id,{name,color}){const token=getToken();const t=await sbFrom('bookmark_categories',token);const patch={};if(name!==undefined)patch.name=name;if(color!==undefined)patch.color=color;await t.update(patch,{id});}
async function dbDeleteCategory(id){const token=getToken();const t=await sbFrom('bookmark_categories',token);await t.delete({id});}
async function dbLoadRecents(userId){const token=getToken();const t=await sbFrom('recent_passages',token);const r=await t.select('*',{user_id:userId},{order:'visited_at.desc',limit:20});return r.data||[];}
async function dbRecordRecent(userId,versionId,bookNum,chapter){const token=getToken();await sbRpc('upsert_recent_passage',{p_user_id:userId,p_version_id:versionId,p_book_num:bookNum,p_chapter:chapter},token);}


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
function IBtn({ch,onClick,danger,T,title,disabled}){return <button className={`s-btn${danger?' s-danger':' s-ghost'}`} onClick={onClick} title={title} disabled={disabled} style={{background:danger?T.red:'transparent',border:`1px solid ${danger?T.redTxt+'33':T.bd+'40'}`,borderRadius:5,color:danger?T.redTxt:T.dim,padding:'4px 9px',fontSize:13,fontFamily:FB,lineHeight:1,fontWeight:500,opacity:disabled?.3:1,cursor:disabled?'default':'pointer'}}>{ch}</button>;}
function PBtn({ch,onClick,T,sm,danger,disabled}){const bg=danger?T.red:T.gF;const bc=danger?T.redTxt+'55':T.gD;const tc=danger?T.redTxt:T.gT;return <button className="s-btn" onClick={onClick} disabled={disabled} style={{background:bg,border:`1px solid ${bc}`,borderRadius:6,color:tc,fontFamily:FS,fontSize:sm?9:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:sm?'6px 13px':'8px 18px',whiteSpace:'nowrap',fontWeight:600,opacity:disabled?.45:1,cursor:disabled?'default':'pointer'}}>{ch}</button>;}
function SBtn({ch,onClick,T}){return <button className="s-btn s-ghost" onClick={onClick} style={{background:'transparent',border:`1px solid ${T.bd}`,borderRadius:6,color:T.dim,fontFamily:FS,fontSize:9.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:'8px 18px',whiteSpace:'nowrap',fontWeight:500}}>{ch}</button>;}
function Badge({type,label,dark}){const bc=(dark?BD:BL)[type]||(dark?BD.other:BL.other);return <span style={{fontFamily:FS,fontSize:8.5,letterSpacing:'0.1em',textTransform:'uppercase',padding:'3px 9px',borderRadius:4,border:`1px solid ${bc.bd}`,background:bc.bg,color:bc.txt,whiteSpace:'nowrap',flexShrink:0,fontWeight:500}}>{label}</span>;}
function Spinner(){return <span className="spinner"/>;}

function Modal({title,onClose,children,footer,wide,T,topSheet,onBack,isClosing}){
  return(
    <div className={topSheet?"modal-overlay modal-topsheet-overlay":"modal-overlay"} onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',...(topSheet?{top:topSheet,right:0,bottom:0,left:0,zIndex:185,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(3px)','--ts-h':topSheet+'px'}:{inset:0,zIndex:200,background:'rgba(0,0,0,0.72)',backdropFilter:'blur(4px)'}),display:'flex',alignItems:'center',justifyContent:'center',padding:20,...(isClosing&&topSheet?{opacity:0,transition:'opacity .25s ease-in'}:{})}}>
      <div className={topSheet?(isClosing?'modal-in modal-panel modal-topsheet-panel slide-down-sheet-out':'modal-in modal-panel modal-topsheet-panel'):'modal-in modal-panel'} style={{background:T.bgCard,...(topSheet?{borderBottom:`2px solid ${T.bdA}`}:{border:`1px solid ${T.bdA}`}),borderRadius:topSheet?'0 0 18px 18px':14,width:`min(95vw,${wide?840:700}px)`,maxHeight:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}}>
        {topSheet?(
          <div style={{background:T.bgCard,padding:'14px 16px',position:'relative',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <div style={{position:'absolute',left:16,top:0,bottom:0,display:'flex',alignItems:'center'}}>
              <button onClick={onBack||onClose} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1}}>←</button>
            </div>
            <span style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>{title}</span>
          </div>
        ):(
          <>
            <div style={{height:3,background:T.accentLine}}/>
            <div style={{background:T.bgCH,borderBottom:`1px solid ${T.bdA}`,padding:'16px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
              <span style={{fontFamily:FS,fontSize:15,fontWeight:600,color:T.gT,letterSpacing:'0.06em'}}>{title}</span>
              <button className="s-btn s-ghost" onClick={onClose} style={{background:'none',border:'none',color:T.dim,fontSize:16,padding:'2px 8px'}}>✕</button>
            </div>
          </>
        )}
        <div className="modal-body" style={{overflowY:'auto',flex:1,padding:'22px 24px'}}>{children}</div>
        {footer&&<div style={{padding:'12px 20px',display:'flex',justifyContent:'flex-end',gap:10,background:T.bgCard,flexShrink:0}}>{footer}</div>}
        {topSheet&&<div style={{display:'flex',justifyContent:'center',padding:'6px 0 10px',flexShrink:0}}><div style={{width:36,height:4,background:T.bdA,borderRadius:2}}/></div>}
        {topSheet&&<div style={{height:3,background:T.accentLine,flexShrink:0}}/>}
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
      <span style={{fontFamily:FS,fontSize:7,letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,marginRight:8,flexShrink:0}}>Key</span>
      <div style={{display:'flex',gap:5,alignItems:'center',minWidth:'max-content'}}>
        {items.map(({bg,txt,label,detail})=>(
          <div key={label} style={{display:'inline-flex',alignItems:'center',gap:4,background:bg,border:`1px solid ${txt}44`,borderRadius:20,padding:'4px 10px 4px 8px',flexShrink:0}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:txt,flexShrink:0}}/>
            <span style={{fontFamily:FS,fontSize:8.5,color:txt,fontWeight:600,letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{label}</span>
            {detail&&<span style={{fontFamily:FB,fontSize:9,color:txt+'aa',lineHeight:1,whiteSpace:'nowrap',fontStyle:'italic'}}>{detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
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
      <style>{CSS}</style>
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
      <style>{CSS}</style>
      <div className="fade-up" style={{textAlign:'center',marginBottom:32}}>
        {offlineVids&&offlineVids.length>0&&(
          <div style={{fontFamily:FS,fontSize:11,letterSpacing:'0.3em',textTransform:'uppercase',color:D.gD,marginBottom:10,fontWeight:500}}>{offlineVids.join(' / ')}</div>
        )}
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
      <div style={{marginTop:16,textAlign:'center'}}>
        <button type="button" onClick={()=>setShowGuestWarning(true)} style={{background:'none',border:'none',color:D.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.1em',cursor:'pointer',fontWeight:400,textDecoration:'underline',padding:0,opacity:0.7}}>Continue without an account</button>
      </div>

      {/* Guest warning modal */}
      {showGuestWarning&&(
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:24}} onClick={e=>e.target===e.currentTarget&&setShowGuestWarning(false)}>
          <div className="modal-in" style={{background:D.bgCard,border:`1px solid ${D.bdA}`,borderRadius:14,width:'min(92vw,400px)',overflow:'hidden',boxShadow:'0 32px 80px rgba(0,0,0,0.8)'}}>
            <div style={{height:3,background:D.accentLine}}/>
            <div style={{padding:'28px 32px'}}>
              <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:D.gT,letterSpacing:'0.08em',marginBottom:16,textAlign:'center'}}>Guest Mode</div>
              <div style={{fontFamily:FB,fontSize:14,color:D.mut,lineHeight:1.7,marginBottom:16}}>You can browse and read without an account, but:</div>
              <ul style={{fontFamily:FB,fontSize:13,color:D.dim,lineHeight:1.9,margin:'0 0 20px 18px',padding:0}}>
                <li>No data saved between sessions</li>
                <li>No study entries or bookmarks</li>
                <li>No sync across devices</li>
                <li>No personal Bible versions</li>
              </ul>
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
const CAT_COLORS=['#62c484','#6ab0f5','#e4cc78','#f08080','#c488c8','#f0a060','#80c8c8','#a0a0b8'];

function BmCard({bm,T,versions,onDelete,onOpen,onUpdate,categories,user,showCatPicker}){
  const bk=BIBLE.find(b=>b.n===bm.book_num);
  const ver=versions.find(v=>v.id===bm.version_id);
  const ref=`${bk?.name||'?'} ${bm.chapter}${bm.verse?':'+bm.verse:''}`;
  const isRangeRef=bm.label&&bk&&(bm.label.startsWith(bk.name)||(bk.nameES&&bm.label.startsWith(bk.nameES)));
  const titleRef=isRangeRef?bm.label:ref;
  const labelNote=isRangeRef?null:bm.label;
  const displayNote=bm.note!=null?bm.note:labelNote;

  const[editNote,setEditNote]=useState(false);
  const[noteVal,setNoteVal]=useState(displayNote||'');
  const[showDelConfirm,setShowDelConfirm]=useState(false);

  function openEditor(){setNoteVal(displayNote||'');setEditNote(true);}
  function saveNote(){onUpdate(bm.id,{note:noteVal});setEditNote(false);}
  function cancelNote(){setNoteVal(displayNote||'');setEditNote(false);}
  function moveCat(catId){onUpdate(bm.id,{categoryId:catId||null});}

  return(
    <div style={{padding:'10px 0',borderBottom:`1px solid ${T.bd}`}}>
      <div style={{display:'flex',alignItems:'flex-start',gap:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}>
            {titleRef} <span style={{color:T.gM,fontWeight:400,fontSize:11}}>{ver?.label||(bm.version_id||'').toUpperCase()}</span>
          </div>
          {!editNote&&displayNote&&<div style={{fontFamily:FB,fontSize:13,color:T.dim,marginTop:3,lineHeight:1.5,whiteSpace:'pre-wrap'}}>{displayNote}</div>}
          {editNote&&(
            <div style={{marginTop:6}}>
              <textarea value={noteVal} onChange={e=>setNoteVal(e.target.value)} rows={3} autoFocus
                style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:13,padding:'6px 8px',outline:'none',resize:'vertical',lineHeight:1.5}}/>
              <div style={{display:'flex',gap:6,marginTop:4}}>
                <button onClick={saveNote} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 10px',cursor:'pointer',fontWeight:600}}>Save</button>
                <button onClick={cancelNote} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 10px',cursor:'pointer'}}>Cancel</button>
              </div>
            </div>
          )}
          {/* Category picker — shown when panel-level assign mode is on */}
          {showCatPicker&&categories.length>0&&(
            <div style={{marginTop:6,display:'flex',flexWrap:'wrap',gap:4}}>
              <button onClick={()=>moveCat(null)}
                style={{background:bm.category_id==null?T.gF:'none',border:`1px solid ${bm.category_id==null?T.gD:T.bd}`,borderRadius:12,color:bm.category_id==null?T.gT:T.dim,fontFamily:FS,fontSize:9,padding:'3px 10px',cursor:'pointer',fontWeight:bm.category_id==null?600:400}}>
                None
              </button>
              {categories.map(c=>(
                <button key={c.id} onClick={()=>moveCat(c.id)}
                  style={{background:bm.category_id===c.id?c.color+'28':'none',border:`1.5px solid ${bm.category_id===c.id?c.color:T.bd}`,borderRadius:12,color:bm.category_id===c.id?c.color:T.dim,fontFamily:FS,fontSize:9,padding:'3px 10px',cursor:'pointer',fontWeight:bm.category_id===c.id?600:400}}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{display:'flex',gap:4,flexShrink:0,alignItems:'center'}}>
          <button className="s-btn s-ghost" onClick={()=>onOpen(bm)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 10px',fontWeight:500}}>Open</button>
          {user&&<>
            <button onClick={()=>editNote?cancelNote():openEditor()} title={displayNote?'Edit note':'Add note'}
              style={{background:editNote||displayNote?T.gF:'none',border:`1px solid ${editNote||displayNote?T.gD:T.bd}`,borderRadius:5,color:editNote||displayNote?T.gT:T.dim,fontFamily:FS,fontSize:11,padding:'4px 7px',cursor:'pointer',lineHeight:1}}>✎</button>
            <IBtn T={T} ch="✕" danger onClick={()=>setShowDelConfirm(true)} title="Delete bookmark"/>
          </>}
        </div>
      </div>
      {showDelConfirm&&<ConfirmDialog T={T} danger
        title="Delete Bookmark"
        message={`Remove "${titleRef}"?\n\nTo move it to a different category instead, use Assign Categories at the top of the list.`}
        confirmLabel="Delete" cancelLabel="Cancel"
        onConfirm={()=>{setShowDelConfirm(false);onDelete(bm.id);}}
        onCancel={()=>setShowDelConfirm(false)}/>}
    </div>
  );
}

function CatSection({cat,bookmarks,T,versions,onDelete,onOpen,onUpdate,onRename,onDeleteCat,categories,user,showCatPicker}){
  const[open,setOpen]=useState(true);
  const[renaming,setRenaming]=useState(false);
  const[nameVal,setNameVal]=useState(cat.name);
  const[colorIdx,setColorIdx]=useState(CAT_COLORS.indexOf(cat.color)<0?0:CAT_COLORS.indexOf(cat.color));
  const[showDelCatConfirm,setShowDelCatConfirm]=useState(false);

  function saveRename(){
    onRename(cat.id,{name:nameVal||cat.name,color:CAT_COLORS[colorIdx]});
    setRenaming(false);
  }

  return(
    <div style={{marginBottom:4}}>
      {/* Section header row */}
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 0 6px',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none'}} onClick={()=>!renaming&&setOpen(v=>!v)}>
        <span style={{fontSize:10,color:T.dim,transition:'transform .15s',display:'inline-block',transform:open?'rotate(90deg)':'rotate(0deg)'}}>▶</span>
        <span style={{width:10,height:10,borderRadius:'50%',background:cat.color,flexShrink:0,display:'inline-block'}}/>
        <span style={{fontFamily:FS,fontSize:12,fontWeight:600,color:T.gT,letterSpacing:'0.06em',flex:1}}>{cat.name}</span>
        <span style={{fontFamily:FS,fontSize:10,color:T.dim,marginRight:4}}>{bookmarks.length}</span>
        {user&&!renaming&&<>
          <button onClick={e=>{e.stopPropagation();setRenaming(true);setOpen(true);}} title="Rename"
            style={{background:'none',border:'none',color:T.dim,fontSize:11,cursor:'pointer',padding:'0 3px',lineHeight:1}}>✎</button>
          <button onClick={e=>{e.stopPropagation();setShowDelCatConfirm(true);}} title="Delete category"
            style={{background:'none',border:'none',color:T.dim,cursor:'pointer',padding:'0 3px',lineHeight:1,display:'flex',alignItems:'center'}}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,3 11,3"/><path d="M4.5,3V2a.5.5,0,0,1,.5-.5h2a.5.5,0,0,1,.5.5v1"/><rect x="2" y="3" width="8" height="7.5" rx=".5"/>
              <line x1="4.5" y1="5.5" x2="4.5" y2="9"/><line x1="7.5" y1="5.5" x2="7.5" y2="9"/>
            </svg>
          </button>
        </>}
      </div>
      {/* Rename form — stacked rows, no horizontal overflow */}
      {renaming&&(
        <div style={{marginBottom:8,padding:'8px 10px',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8}} onClick={e=>e.stopPropagation()}>
          <input value={nameVal} onChange={e=>setNameVal(e.target.value)} autoFocus onKeyDown={e=>e.key==='Enter'&&saveRename()}
            style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:5,color:T.body,fontFamily:FS,fontSize:13,padding:'6px 8px',outline:'none',marginBottom:8}}/>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            <div style={{display:'flex',gap:4,flex:1,flexWrap:'wrap'}}>
              {CAT_COLORS.map((c,i)=>(
                <button key={c} onClick={()=>setColorIdx(i)}
                  style={{width:18,height:18,borderRadius:'50%',background:c,border:`2px solid ${i===colorIdx?T.gT:'transparent'}`,cursor:'pointer',padding:0,flexShrink:0}}/>
              ))}
            </div>
            <button onClick={()=>setRenaming(false)} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,padding:'4px 10px',cursor:'pointer',flexShrink:0}}>Cancel</button>
            <button onClick={saveRename} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:9,padding:'4px 10px',cursor:'pointer',fontWeight:600,flexShrink:0}}>Save</button>
          </div>
        </div>
      )}
      {open&&<div style={{paddingLeft:18}}>
        {bookmarks.length===0
          ?<div style={{fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:13,padding:'6px 0 10px'}}>Empty category</div>
          :bookmarks.map(bm=><BmCard key={bm.id} bm={bm} T={T} versions={versions} onDelete={onDelete} onOpen={onOpen} onUpdate={onUpdate} categories={categories} user={user} showCatPicker={showCatPicker}/>)
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

function BookmarksPanel({T,bookmarks,categories,onDelete,onOpen,onClose,onUpdate,onAddCat,onDeleteCat,onUpdateCat,versions,user,navH,isClosing}){
  const[newCatName,setNewCatName]=useState('');
  const[newCatColor,setNewCatColor]=useState(0);
  const[addingCat,setAddingCat]=useState(false);
  const[viewAll,setViewAll]=useState(false);
  const[assigningCats,setAssigningCats]=useState(false);

  async function createCat(){
    if(!newCatName.trim())return;
    await onAddCat(newCatName.trim(),CAT_COLORS[newCatColor]);
    setNewCatName('');setNewCatColor(0);setAddingCat(false);
  }

  const grouped=categories.map(cat=>({cat,items:bookmarks.filter(bm=>bm.category_id===cat.id)}));
  const uncategorized=bookmarks.filter(bm=>!bm.category_id);
  const hasCats=categories.length>0;
  const bmCardProps={T,versions,onDelete,onOpen,onUpdate,categories,user,showCatPicker:assigningCats};

  return(
    <Modal title="✦ Bookmarks" onClose={onClose} T={T} topSheet={navH} isClosing={isClosing} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {!user&&<div style={{background:T.bgCH,border:`1px solid ${T.bd}`,borderRadius:8,padding:'12px 14px',marginBottom:16,display:'flex',gap:10,alignItems:'flex-start'}}>
        <span style={{fontSize:16,flexShrink:0}}>⚠</span>
        <div>
          <div style={{fontFamily:FS,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:T.gT,marginBottom:4}}>SIGN IN REQUIRED</div>
          <div style={{fontFamily:FB,fontSize:13,color:T.mut,lineHeight:1.6}}>Bookmarks are saved to your account. Sign in to save and view bookmarks.</div>
        </div>
      </div>}

      {user&&!user.guest&&(
        <div style={{marginBottom:12}}>
          {/* New category form — stacked rows, mobile-safe */}
          {addingCat?(
            <div style={{padding:'10px',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,marginBottom:8}}>
              <input value={newCatName} onChange={e=>setNewCatName(e.target.value)} autoFocus placeholder="Category name…"
                onKeyDown={e=>e.key==='Enter'&&createCat()}
                style={{width:'100%',boxSizing:'border-box',background:T.bgIn,border:`1px solid ${T.gD}`,borderRadius:5,color:T.body,fontFamily:FS,fontSize:13,padding:'7px 8px',outline:'none',marginBottom:8}}/>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{display:'flex',gap:4,flex:1,flexWrap:'wrap'}}>
                  {CAT_COLORS.map((c,i)=>(
                    <button key={c} onClick={()=>setNewCatColor(i)}
                      style={{width:20,height:20,borderRadius:'50%',background:c,border:`2px solid ${i===newCatColor?T.gT:'transparent'}`,cursor:'pointer',padding:0,flexShrink:0}}/>
                  ))}
                </div>
                <button onClick={()=>{setAddingCat(false);setNewCatName('');}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:9,padding:'5px 10px',cursor:'pointer',flexShrink:0}}>Cancel</button>
                <button onClick={createCat} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 12px',cursor:'pointer',fontWeight:600,flexShrink:0}}>Create</button>
              </div>
            </div>
          ):(
            <button onClick={()=>setAddingCat(true)}
              style={{background:'none',border:`1px dashed ${T.bd}`,borderRadius:8,color:T.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',padding:'7px 14px',cursor:'pointer',width:'100%',boxSizing:'border-box',textAlign:'left',marginBottom:hasCats?8:0}}>
              + New Category
            </button>
          )}
          {/* View toggles — only shown when categories exist */}
          {hasCats&&(
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>setViewAll(v=>!v)}
                style={{flex:1,background:viewAll?T.gF:'none',border:`1px solid ${viewAll?T.gD:T.bd}`,borderRadius:8,color:viewAll?T.gT:T.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'7px 0',cursor:'pointer'}}>
                {viewAll?'By Category':'View All'}
              </button>
              <button onClick={()=>setAssigningCats(v=>!v)}
                style={{flex:1,background:assigningCats?T.gF:'none',border:`1px solid ${assigningCats?T.gD:T.bd}`,borderRadius:8,color:assigningCats?T.gT:T.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'7px 0',cursor:'pointer'}}>
                {assigningCats?'Done Assigning':'Assign Categories'}
              </button>
            </div>
          )}
        </div>
      )}

      {bookmarks.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>{user?'No bookmarks yet. In Reading Mode, tap any verse to bookmark it.':'No bookmarks. Sign in to save passages.'}</div>}

      {/* Flat list */}
      {viewAll&&hasCats?(
        bookmarks.map(bm=><BmCard key={bm.id} bm={bm} {...bmCardProps}/>)
      ):(
        <>
          {grouped.map(({cat,items})=>(
            <CatSection key={cat.id} cat={cat} bookmarks={items} T={T} versions={versions}
              onDelete={onDelete} onOpen={onOpen} onUpdate={onUpdate}
              onRename={onUpdateCat} onDeleteCat={onDeleteCat}
              categories={categories} user={user} showCatPicker={assigningCats}/>
          ))}
          {uncategorized.length>0&&(
            <div style={{marginTop:hasCats?8:0}}>
              {hasCats&&<div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',color:T.dim,textTransform:'uppercase',padding:'6px 0 4px'}}>Uncategorized</div>}
              {uncategorized.map(bm=><BmCard key={bm.id} bm={bm} {...bmCardProps}/>)}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function RecentsPanel({T,recents,onOpen,onClose,versions,navH,isClosing}){
  return(
    <Modal title="↺ Recent Passages" onClose={onClose} T={T} topSheet={navH} isClosing={isClosing} footer={<SBtn ch="Close" onClick={onClose} T={T}/>}>
      {recents.length===0&&<div style={{textAlign:'center',padding:'32px 0',fontFamily:FB,fontStyle:'italic',color:T.dim,fontSize:15}}>No recent passages yet. Browse chapters in Reading Mode.</div>}
      {recents.map(r=>{
        const bk=BIBLE.find(b=>b.n===r.book_num);const ver=versions.find(v=>v.id===r.version_id);
        return(
          <div key={r.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:`1px solid ${T.bd}`}}>
            <div style={{flex:1}}>
              <span style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}>{bk?.name} {r.chapter}</span>
              <span style={{fontFamily:FB,fontSize:13,color:T.dim,marginLeft:10}}>{ver?.label||(r.version_id||'').toUpperCase()}</span>
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
function VersionsModal({data,onSave,onClose,T,dlStates={},onDownload,onDeleteLocal,navH,onBack,isClosing}){
  const[vers,setVers]=useState(clone(data.versions));
  const builtinAvail=PUBLIC_VERSIONS.filter(pv=>!vers.find(v=>v.id===pv.id));

  function remove(id){setVers(v=>v.filter(x=>x.id!==id));}
  function addBuiltin(pv){setVers(v=>[...v,{id:pv.id,label:pv.label,lang:pv.lang,isRef:false}]);}
  function doSave(){let v=[...vers];if(!v.some(x=>x.isRef)&&v.length)v[0]={...v[0],isRef:true};onSave(v);}

  return(
    <Modal title="Bible Versions" onClose={onClose} onBack={onBack} wide T={T} topSheet={navH} isClosing={isClosing} footer={<><SBtn ch="Cancel" onClick={onClose} T={T}/><PBtn ch="Save" onClick={doSave} T={T}/></>}>
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
      <div style={{marginTop:20,paddingTop:16}}>
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
  const refLang=(versions.find(v=>v.isRef)||versions[0])?.lang||'EN';
  const displayRef=parsed?`${bookName(BIBLE[parsed.bookNum-1],refLang)} ${parsed.chapter}:${parsed.verse}`:entry.reference;
  return(
    <div id={`card-${entry.id}`} className={`entry-card hov-card fade-up${pulse?' pulse':''}`}
      style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,marginBottom:12,overflow:'hidden',boxShadow:`0 2px 8px rgba(0,0,0,${dark?.3:.06})`,animationDelay:`${delay}s`}}>
      <div style={{height:2,background:`linear-gradient(90deg, ${typeColor.bd}, ${typeColor.bd}60, transparent)`}}/>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',padding:'11px 18px',borderBottom:`1px solid ${T.bd}`}}>
        <span dangerouslySetInnerHTML={{__html:hl(displayRef,q)}} style={{fontFamily:FS,fontSize:14.5,fontWeight:600,color:T.gT,letterSpacing:'0.04em'}}/>
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
        <span style={{color:T.gM,fontSize:9,display:'inline-block',transition:'transform .2s',transform:col?'rotate(-90deg)':'none'}}>▼</span>
        <span style={{fontFamily:FS,fontSize:12.5,fontWeight:600,color:T.gT,letterSpacing:'0.04em',flex:1,minWidth:60}}>{sec.title}</span>
        <span style={{fontFamily:FS,fontSize:9.5,color:T.dim,letterSpacing:'0.1em',fontWeight:500}}>{entries.length} {entries.length===1?'entry':'entries'}</span>
        <div style={{display:'flex',gap:5}} onClick={e=>e.stopPropagation()}>
          <select className="s-btn hide-mobile" value={sortBy} onChange={e=>{e.stopPropagation();setSortBy(e.target.value);}} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:5,color:T.dim,fontFamily:FS,fontSize:8.5,letterSpacing:'0.06em',padding:'3px 6px',outline:'none',cursor:'pointer'}}>
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
          <button className="s-btn" onClick={doFill} disabled={!bkN||!ch||!vs||filling} style={{marginTop:8,background:T.bgSec,border:`1px dashed ${T.gD}`,color:T.gM,fontFamily:FS,fontSize:9.5,letterSpacing:'0.08em',padding:'6px 13px',borderRadius:5,opacity:(!bkN||!ch||!vs||filling)?.45:1,fontWeight:500}}>{filling?<><Spinner/> Filling…</>:'⚡ Auto-fill verse text for all versions'}</button>
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
  const statusMeta={faithful:{bg:T.green,txt:T.greenTxt},corrupt:{bg:T.red,txt:T.redTxt},diff:{bg:T.dif,txt:T.difTxt},partial:{bg:T.ora,txt:T.oraTxt},missing:{bg:T.pur,txt:T.purTxt}};
  return(
    <div className="no-print" style={{borderTop:`1px solid ${T.bdS}`}}>
      <div style={{display:'flex',alignItems:'center',gap:6,padding:'4px 8px 4px 10px'}}>
        <button type="button" onClick={()=>setOpen(!open)}
          style={{display:'flex',alignItems:'center',gap:6,background:'transparent',border:'none',cursor:'pointer',padding:'4px 6px',borderRadius:6,color:active>0?T.gT:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.1em',fontWeight:active>0?600:500,flexShrink:0}}>
          <span style={{display:'inline-block',transition:'transform .2s',transform:open?'rotate(90deg)':'none',fontSize:8,lineHeight:1}}>▸</span>
          <span>Filters</span>
          {active>0&&<span style={{background:T.gF,border:`1px solid ${T.gD}`,color:T.gT,fontSize:8,padding:'1px 6px',borderRadius:10,fontWeight:700,letterSpacing:'0.04em'}}>{active}</span>}
        </button>
        {!open&&filters.statuses.length>0&&<div style={{display:'flex',gap:3,overflowX:'auto',scrollbarWidth:'none'}}>
          {filters.statuses.map(s=>{const m=statusMeta[s];return m?(
            <div key={s} style={{display:'inline-flex',alignItems:'center',gap:3,background:m.bg,border:`1px solid ${m.txt}44`,borderRadius:20,padding:'2px 7px',flexShrink:0}}>
              <div style={{width:5,height:5,borderRadius:'50%',background:m.txt}}/>
              <span style={{fontFamily:FS,fontSize:7.5,color:m.txt,fontWeight:600,whiteSpace:'nowrap'}}>{STATUS_LABELS[s]}</span>
            </div>
          ):null;})}
        </div>}
        {hiddenVers!==undefined&&togVer&&(
          <div style={{display:'flex',alignItems:'center',gap:4,marginLeft:'auto',flexShrink:0}}>
            {versions.map(v=>{const hidden=hiddenVers.includes(v.id);return(
              <button key={v.id} type="button" onClick={()=>togVer(v.id)}
                style={{background:hidden?'transparent':T.gF,border:`1px solid ${hidden?T.bd:T.gD}`,borderRadius:6,color:hidden?T.dim:T.gT,fontFamily:FS,fontSize:7,letterSpacing:'0.07em',padding:'3px 7px',fontWeight:hidden?400:600,opacity:hidden?.5:1,cursor:'pointer',transition:'all .15s',textDecoration:hidden?'line-through':'none'}}>
              {v.label}
            </button>);})}
            {(onExpand||onCollapse)&&<>
              <div style={{width:1,height:14,background:T.bd,marginLeft:1}}/>
              <button type="button" title="Expand all" onClick={onExpand} style={{background:'transparent',border:'none',color:T.dim,fontSize:12,padding:'2px 4px',cursor:'pointer',lineHeight:1}}>▾</button>
              <button type="button" title="Collapse all" onClick={onCollapse} style={{background:'transparent',border:'none',color:T.dim,fontSize:12,padding:'2px 4px',cursor:'pointer',lineHeight:1}}>▴</button>
            </>}
          </div>
        )}
      </div>
      {open&&(
        <div className="slide-down" style={{padding:'12px 12px 14px',background:T.bgSec,borderTop:`1px solid ${T.bdS}`,display:'flex',flexDirection:'column',gap:14}}>
          <div>
            <div style={{fontFamily:FS,fontSize:7.5,letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Status</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {['faithful','corrupt','diff','partial','missing'].map(s=>{
                const m=statusMeta[s];const on=filters.statuses.includes(s);
                return m?(
                  <button key={s} type="button" onClick={()=>togS(s)}
                    style={{display:'inline-flex',alignItems:'center',gap:5,background:on?m.bg:'transparent',border:`1px solid ${on?m.txt+'66':T.bd}`,borderRadius:20,padding:'5px 11px 5px 9px',cursor:'pointer',transition:'all .15s'}}>
                    <div style={{width:7,height:7,borderRadius:'50%',background:on?m.txt:T.bd,flexShrink:0,transition:'background .15s'}}/>
                    <span style={{fontFamily:FS,fontSize:9,color:on?m.txt:T.dim,fontWeight:on?600:400,letterSpacing:'0.04em',whiteSpace:'nowrap'}}>{STATUS_LABELS[s]}</span>
                  </button>
                ):null;
              })}
            </div>
          </div>
          <div>
            <div style={{fontFamily:FS,fontSize:7.5,letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Issue Type</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {ISSUE_TYPES.map(t=>{const on=filters.issueTypes.includes(t);return(
                <button key={t} type="button" onClick={()=>togI(t)}
                  style={{background:on?T.gF:'transparent',border:`1px solid ${on?T.gD:T.bd}`,borderRadius:20,padding:'5px 11px',cursor:'pointer',transition:'all .15s'}}>
                  <span style={{fontFamily:FS,fontSize:9,color:on?T.gT:T.dim,fontWeight:on?600:400,letterSpacing:'0.04em'}}>{ISSUE_LABELS[t]||t}</span>
                </button>
              );})}
            </div>
          </div>
          <div>
            <div style={{fontFamily:FS,fontSize:7.5,letterSpacing:'0.16em',textTransform:'uppercase',color:T.gM,marginBottom:7,fontWeight:600}}>Version Alignment</div>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <select value={filters.vA} onChange={e=>setFilters(f=>({...f,vA:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:13,padding:'6px 10px',outline:'none',flex:1,minWidth:80}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
              <span style={{color:T.gM,fontFamily:FS,fontSize:13,fontWeight:600}}>≠</span>
              <select value={filters.vB} onChange={e=>setFilters(f=>({...f,vB:e.target.value}))} style={{background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:7,color:T.mut,fontFamily:FB,fontSize:13,padding:'6px 10px',outline:'none',flex:1,minWidth:80}}><option value="">— any —</option>{versions.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
            </div>
          </div>
          {active>0&&<button type="button" onClick={()=>setFilters({issueTypes:[],statuses:[],vA:'',vB:''})}
            style={{alignSelf:'flex-start',background:'transparent',border:`1px solid ${T.bd}`,color:T.dim,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'5px 12px',borderRadius:20,cursor:'pointer',fontWeight:500}}>
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
  const closing=isClosing||internalClosing;
  const startY=React.useRef(null);

  function dismiss(){setInternalClosing(true);onClose();}

  function onTouchStart(e){startY.current=e.touches[0].clientY;}
  function onTouchMove(e){
    if(startY.current===null)return;
    const dy=e.touches[0].clientY-startY.current;
    if(fromTop){if(dy<0)setDragY(dy);}else{if(dy>0)setDragY(dy);}
  }
  function onTouchEnd(){
    if(Math.abs(dragY)>80){dismiss();}
    else{setDragY(0);}
    startY.current=null;
  }

  const closeTx=fromTop?'translateY(-100%)':'translateY(100%)';
  const dragTx=`translateY(${dragY}px)`;

  return(
    <div onClick={e=>{if(e.target===e.currentTarget)dismiss();}}
      style={{position:'fixed',inset:0,zIndex:180,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(3px)',
        opacity:closing?0:1,transition:closing?'opacity .25s ease-in':'none'}}>
      <div className={closing?(fromTop?'slide-down-sheet-out':'slide-up-sheet-out'):(fromTop?'slide-down-sheet':'slide-up-sheet')} onClick={e=>e.stopPropagation()}
        style={{position:'absolute',...(fromTop?{top:topOffset}:{bottom:0}),left:0,right:0,background:T.bgCard,
          borderRadius:fromTop?'0 0 18px 18px':'18px 18px 0 0',
          ...(fromTop?{borderBottom:`2px solid ${T.bdA}`}:{borderTop:`2px solid ${T.bdA}`}),
          maxHeight:sheetHeight||maxSheetHeight||(fullScreen?'100vh':fromTop?`calc(100vh - ${topOffset}px - 50px)`:'82vh'),height:sheetHeight||(fullScreen?'100vh':undefined),display:'flex',flexDirection:'column',overflow:'hidden',
          boxShadow:fromTop?'0 20px 60px rgba(0,0,0,0.5)':'0 -20px 60px rgba(0,0,0,0.5)',
          transform:(!closing&&dragY!==0)?dragTx:undefined,
          transition:(!closing&&dragY===0)?'transform .2s ease-out, max-height .12s cubic-bezier(0.4,0,0.2,1), height .12s cubic-bezier(0.4,0,0.2,1)':'none'}}>

        {!fromTop&&<div style={{height:3,background:T.accentLine}}/>}
        {!fromTop&&<div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          style={{display:'flex',flexDirection:'column',alignItems:'center',padding:'10px 0 2px',flexShrink:0,touchAction:'none',cursor:'grab'}}>
          <div style={{width:36,height:4,background:T.bdA,borderRadius:2,marginBottom:6}}/>
          {title&&<div style={{fontFamily:FS,fontSize:11,fontWeight:600,color:T.gT,letterSpacing:'0.1em',marginBottom:2}}>{title}</div>}
        </div>}
        <div style={{overflowY:noScroll?'hidden':'auto',flex:1,padding:fromTop?`${topPad??20}px 18px 32px`:'6px 18px 32px'}} onScroll={onScroll}>
          {children}
        </div>
        {fromTop&&<div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
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
  const[customAccentHex,setCustomAccentHex]=useState(()=>{try{return localStorage.getItem('scrip:accentCustom')||'#c8a84e';}catch{return '#c8a84e';}});
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
  const _topSheetTypes=['versions','bookmarks','recents','help'];
  function closeModal(then){
    if(_topSheetTypes.includes(modal?.type)){
      setModalClosing(true);
      setTimeout(()=>{setModal(null);setModalClosing(false);if(then)then();},260);
    }else{setModal(null);if(then)then();}
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
  function closeReadSheet(){setReadSheetClosing(true);setTimeout(()=>{setReadMobileSheet(null);setReadSheetClosing(false);setVersionSheetView('list');},260);}
  function openManageView(){setManageVers(clone(data.versions));setVersionSheetView('manage');}
  function manageRemove(id){setManageVers(v=>v.filter(x=>x.id!==id));}
  function manageAddBuiltin(pv){setManageVers(v=>[...v,{id:pv.id,label:pv.label,lang:pv.lang,isRef:false}]);}
  function manageDoSave(){let v=[...manageVers];if(!v.some(x=>x.isRef)&&v.length)v[0]={...v[0],isRef:true};saveVersions(v);setVersionSheetView('list');}

  // ── Reading state (persistent in tab, not modal) ──
  const[readBook,setReadBook]=useState(()=>{try{return Number(localStorage.getItem('scrip:readBook'))||1;}catch{return 1;}});
  const[readCh,setReadCh]=useState(()=>{try{return Number(localStorage.getItem('scrip:readCh'))||1;}catch{return 1;}});
  const[readVid,setReadVid]=useState(null); // set after data loads
  const[readVerses,setReadVerses]=useState([]);
  const[readSelVerses,setReadSelVerses]=useState(()=>new Set()); // multi-select
  const[stripOpen,setStripOpen]=useState(false);
  const[stripClosing,setStripClosing]=useState(false);
  const[copyHover,setCopyHover]=useState(false);
  const[bmHover,setBmHover]=useState(false);
  const[scrubberVisible,setScrubberVisible]=useState(false);
  const scrubberTimerRef=useRef(null);
  const longPressTimer=useRef(null);
  const longPressFired=useRef(false);
  const wasTouchEvent=useRef(false);
  const verseTouchStartY=useRef(0);
  const verseTouchScrolled=useRef(false);
  const readScrollToVerse=useRef(null);
  const readPendingSelVerses=useRef(null); // Set of verse numbers to select after chapter loads
  const prevReadStateRef=useRef({vid:null,book:null,ch:null}); // track previous vid/book/ch for version-change detection
  function dismissStrip(){setCopyHover(false);setBmHover(false);setStripClosing(true);setTimeout(()=>{setReadSelVerses(new Set());setStripOpen(false);setStripClosing(false);},160);}
  function openStrip(v){if(readFullScreen.current)exitFullScreen();setCopyHover(false);setBmHover(false);setReadSelVerses(s=>{const ns=new Set(s);ns.add(v);return ns;});setStripOpen(true);}
  function verseTouchStart(v,e){longPressFired.current=false;wasTouchEvent.current=true;verseTouchScrolled.current=false;verseTouchStartY.current=e.touches[0].clientY;if(!_wlpActive&&!audioPlaying){longPressTimer.current=setTimeout(()=>{longPressFired.current=true;longPressTimer.current=null;openStrip(v);},500);}}
  function verseTouchMove(e){if(Math.abs(e.touches[0].clientY-verseTouchStartY.current)>8){verseTouchScrolled.current=true;if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}}}
  function handleVerseToggle(v){const willEmpty=readSelVerses.has(v)&&readSelVerses.size===1;setReadSelVerses(s=>{const ns=new Set(s);ns.has(v)?ns.delete(v):ns.add(v);return ns;});if(willEmpty&&stripOpen)dismissStrip();}
  function verseTouchEnd(v){if(longPressTimer.current){clearTimeout(longPressTimer.current);longPressTimer.current=null;}if(!longPressFired.current&&!verseTouchScrolled.current&&!audioPlaying){if(readSelVerses.has(v)){handleVerseToggle(v);}else{openStrip(v);}}setTimeout(()=>{wasTouchEvent.current=false;},300);}
  function verseClick(v){if(wasTouchEvent.current)return;if(audioPlaying)return;if(readFullScreen.current)exitFullScreen();if(readSelVerses.has(v)){if(stripOpen)handleVerseToggle(v);else openStrip(v);}else{openStrip(v);}}
  const[readBmLabel,setReadBmLabel]=useState('');
  const[readBmCat,setReadBmCat]=useState('');
  const[readBmLabelFocused,setReadBmLabelFocused]=useState(false);
  const[readBmOk,setReadBmOk]=useState(false);
  const[readCopyOk,setReadCopyOk]=useState(false);
  const[readSearchQ,setReadSearchQ]=useState('');
  const[readSearchRes,setReadSearchRes]=useState(null);
  const[readSearchResultsOpen,setReadSearchResultsOpen]=useState(false);
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
  const versionContentRef=useRef(null);
  const[versionSheetH,setVersionSheetH]=useState(null);
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
  const[offlineDataOpen,setOfflineDataOpen]=useState(false);
  const[readFontSize,setReadFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:fontSize'))||31;}catch{return 31;}});
  const[parallelFontSize,setParallelFontSize]=useState(()=>{try{return Number(localStorage.getItem('scrip:parallelFontSize'))||16;}catch{return 16;}});
  const[readLineHeight,setReadLineHeight]=useState(()=>{try{return Number(localStorage.getItem('scrip:lineHeight'))||1.2;}catch{return 1.2;}});
  const[readFontFamily,setReadFontFamily]=useState(()=>{try{return localStorage.getItem('scrip:fontFamily')||'serif';}catch{return 'serif';}});
  const[readVerseNums,setReadVerseNums]=useState(()=>{try{return localStorage.getItem('scrip:verseNums')||'super';}catch{return 'super';}});
  const[readTextAlign,setReadTextAlign]=useState(()=>{try{return localStorage.getItem('scrip:textAlign')||'left';}catch{return 'left';}});
  const[readParaMode,setReadParaMode]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:paraMode'))===true;}catch{return false;}});
  const[readRedLetter,setReadRedLetter]=useState(()=>{try{const v=localStorage.getItem('scrip:redLetter');return v===null?true:JSON.parse(v)===true;}catch{return true;}});
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
  const[audioAutoAdvance,setAudioAutoAdvance]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:autoAdvance')??'false');}catch{return false;}});
  const[audioInfoOpen,setAudioInfoOpen]=useState(null); // 'scroll'|'advance'|null
  const[voicesByVersion,setVoicesByVersion]=useState(()=>{try{return JSON.parse(localStorage.getItem('scrip:audio:voices')||'{}');}catch{return {};}});
  const[availableVoices,setAvailableVoices]=useState(()=>speechSynthesis.getVoices());
  const readFullScreen=useRef(false);
  const fsTransitioning=useRef(false);
  const[fsActive,setFsActive]=useState(false);
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
    if(b){b.style.willChange='transform';bottomAnimRef.current=b.animate([{transform:'translateY(0)'},{transform:'translateY(100%)'}],{duration:180,easing:'ease-in',fill:'forwards'});}
    setTimeout(()=>{fsTransitioning.current=false;},180);
  }
  function exitFullScreen(){
    if(!readFullScreen.current||fsTransitioning.current)return;
    readFullScreen.current=false;fsTransitioning.current=true;setFsActive(false);
    if(headerAnimRef.current){headerAnimRef.current.cancel();headerAnimRef.current=null;}
    if(bottomAnimRef.current){bottomAnimRef.current.cancel();bottomAnimRef.current=null;}
    const h=navRef.current,b=bottomBarRef.current;
    if(h){h.style.willChange='transform';const a=h.animate([{transform:'translateY(-100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>{a.cancel();h.style.willChange='';}}
    if(b){b.style.willChange='transform';const a=b.animate([{transform:'translateY(100%)'},{transform:'translateY(0)'}],{duration:180,easing:'ease-out',fill:'forwards'});a.onfinish=()=>{a.cancel();b.style.willChange='';}}
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
  const scrollPendingState=useRef(null);
  function handleReadScroll(e){
    if(readSearchRes&&readSearchResultsOpen){if(readFullScreen.current)exitFullScreen();scrollDelta.current=0;return;}
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
  const closeStrongsPopup=React.useCallback(()=>{
    setStrongsClosing(true);
    setTimeout(()=>{setStrongsPopup(null);setStrongsVersePreview(null);setStrongsClosing(false);},260);
  },[]);
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
  const [bottomBarH,setBottomBarH]=useState(0);
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
  useLayoutEffect(()=>{
    const el=document.createElement('audio');
    el.style.display='none';
    document.body.appendChild(el);
    audioElRef.current=el;
    return()=>{el.remove();};
  },[]);
  const audioTimestampsRef=useRef(null);
  const audioUtterRef=useRef([]);
  const audioModeRef=useRef(null); // tracks what is actually playing: 'fcbh'|'local'|'speech'|null
  const currentVerseRef=useRef(null); // mirror of currentVerse for use inside event handlers
  const autoAdvancePendingRef=useRef(false); // set before chapter change so new chapter auto-starts
  const msBookRef=useRef(readBook);
  const msChRef=useRef(readCh);
  useEffect(()=>{msBookRef.current=readBook;},[readBook]);
  useEffect(()=>{msChRef.current=readCh;},[readCh]);

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
    r.textContent=`:root{--ac-scrollbar:${T.gD};--ac-mark:rgba(${rgb},0.22);--ac-bd:${T.gD};--ac-ghost-bg:rgba(${rgb},0.09);--ac-ghost-bd:rgba(${rgb},0.3);--ac-tbtn-bd:rgba(${rgb},0.5);--ac-tbtn-bg:rgba(${rgb},0.06);--ac-focus:rgba(${rgb},0.4);--ac-pulse0:rgba(${rgb},0);--ac-pulse50:rgba(${rgb},0.25);--ac-shimmer:rgba(${rgb},0.12);--ac-spin-ring:rgba(${rgb},0.2);--ac-spin-top:${T.g};--ac-verse-hover:rgba(${rgb},0.05);--ac-input-bd:rgba(${rgb},0.27);--ac-input-sh:rgba(${rgb},0.08);--ac-audio-bg:rgba(${rgb},0.15);--ac-audio-ring:rgba(${rgb},0.4);--ac-audio-line:rgba(${rgb},0.5);--ac-sel-glow:rgba(${rgb},0.18);}`;
    if(!r.parentNode)document.head.appendChild(r);
  },[T.g,T.gD]);

  // ── Audio playback functions ──
  const scrollToVerse=(v)=>{
    if(!readRef.current)return;
    const el=readRef.current.querySelector(`[data-verse="${v}"]`);
    if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
  };
  const stopAudio=()=>{
    audioModeRef.current=null;currentVerseRef.current=null;
    setAudioLoaded(false);setCurrentVerse(null);
    speechSynthesis.cancel();audioUtterRef.current=[];
    if(audioElRef.current){audioElRef.current.pause();audioElRef.current.src='';}
    setAudioPlaying(false);
  };
  const updateMediaSession=(bookNum,ch)=>{
    if(!('mediaSession' in navigator))return;
    const bk=BIBLE[bookNum-1];
    navigator.mediaSession.metadata=new MediaMetadata({
      title:bk?`${bk.name} ${ch}`:'Scriptorium',
      artist:'Scriptorium',
      album:'The Bible',
    });
  };
  const loadChapterAudio=async(srcOverride=null)=>{
    if(!readVerses||!readVerses.length){setAudioError('No verses loaded');return;}
    setAudioError(null);setAudioLoading(true);
    speechSynthesis.cancel();audioUtterRef.current=[];
    if(audioElRef.current){audioElRef.current.pause();}
    // Only seek if the user explicitly selected a verse; otherwise play from 0 to include chapter intro
    const startVerse=readSelVerses.size>0?Math.min(...readSelVerses):null;
    const hasFcbhKey=!!(localStorage.getItem('scrip:audio:fcbhKey')||'').trim();
    const src=srcOverride||(audioSource==='auto'
      ?(readVid==='kjv'?'local':DEFAULT_FILESETS[readVid]&&hasFcbhKey?'fcbh':'speech')
      :(audioSource==='off'?null:audioSource));
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
            setAudioError('Audio file not found. Import the KJV audio ZIP in Settings → Audio Playback.');
            setAudioLoading(false);return;
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
        audioModeRef.current='speech';
        const voices=speechSynthesis.getVoices();
        const lang=['rvg','p1602'].includes(readVid)?'es':'en';
        const _saved=voicesByVersion[readVid];
        const _pref=lang==='es'?'Paulina':'Daniel';
        const _prefVoice=voices.find(v=>v.name===_pref||v.name.startsWith(_pref+' '));
        const voice=_saved?voices.find(v=>v.name===_saved)||voices.find(v=>v.lang.startsWith(lang))||voices[0]:_prefVoice||voices.find(v=>v.lang.startsWith(lang)&&v.default)||voices.find(v=>v.lang.startsWith(lang))||voices[0];
        audioUtterRef.current=[];
        speechSynthesis.cancel();
        const startIdx=startVerse?Math.max(0,readVerses.findIndex(v=>v.verse>=startVerse)):0;
        const versesToSpeak=readVerses.slice(startIdx);
        const lastVerse=readVerses[readVerses.length-1]?.verse;
        versesToSpeak.forEach(({verse,text})=>{
          const u=new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g,''));
          u.voice=voice;u.rate=audioRate;
          u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)scrollToVerse(verse);};
          u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
          audioUtterRef.current.push(u);
        });
        setAudioLoaded(true);
        updateMediaSession(readBook,readCh);
        audioUtterRef.current.forEach(u=>speechSynthesis.speak(u));
        currentVerseRef.current=startVerse;setAudioPlaying(true);setCurrentVerse(startVerse);
      }else throw new Error('No audio source available');
    }catch(e){
      setAudioError(e.message);
      setAudioLoaded(false);
      setAudioPlaying(false);
    }finally{setAudioLoading(false);}
  };
  const handleNextChapter=()=>{
    const current=BIBLE.find(b=>b.n===readBook);
    if(!current||readCh>=current.v.length){return;}
    autoAdvancePendingRef.current=true;
    setReadCh(readCh+1);
  };
  const handlePlayPause=async()=>{
    if(audioPlaying){
      audioElRef.current?.pause();
      speechSynthesis.pause();
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
      if(speechSynthesis.paused){
        if(selVerse){
          setReadSelVerses(new Set());
          if(stripOpen)dismissStrip();
          seekWebSpeechToVerse(selVerse);
          setAudioPlaying(true);
        }else{
          speechSynthesis.resume();
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
    speechSynthesis.cancel();
    audioUtterRef.current=[];
    const voices=speechSynthesis.getVoices();
    const lang=['rvg','p1602'].includes(readVid)?'es':'en';
    const _saved=voicesByVersion[readVid];
    const _pref=lang==='es'?'Paulina':'Daniel';
    const _prefVoice=voices.find(v=>v.name===_pref||v.name.startsWith(_pref+' '));
    const voice=_saved?voices.find(v=>v.name===_saved)||voices.find(v=>v.lang.startsWith(lang))||voices[0]:_prefVoice||voices.find(v=>v.lang.startsWith(lang)&&v.default)||voices.find(v=>v.lang.startsWith(lang))||voices[0];
    const lastVerse=readVerses[readVerses.length-1]?.verse;
    for(let i=startIdx;i<readVerses.length;i++){
      const {verse,text}=readVerses[i];
      const u=new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g,''));
      u.voice=voice;u.rate=audioRate;
      u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)scrollToVerse(verse);};
      u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
      audioUtterRef.current.push(u);
    }
    audioUtterRef.current.forEach(u=>speechSynthesis.speak(u));
    currentVerseRef.current=targetVerse;setCurrentVerse(targetVerse);
    if(audioAutoScroll)scrollToVerse(targetVerse);
  };

  // Called directly from onClick handlers so iOS WKWebView recognises the user gesture
  const doStartSpeech=(startVerse)=>{
    if(!readVerses||!readVerses.length)return;
    audioModeRef.current='speech';
    if(audioElRef.current){audioElRef.current.pause();audioElRef.current.src='';}
    const voices=speechSynthesis.getVoices();
    const lang=['rvg','p1602'].includes(readVid)?'es':'en';
    const _saved=voicesByVersion[readVid];
    const _pref=lang==='es'?'Paulina':'Daniel';
    const _prefVoice=voices.find(v=>v.name===_pref||v.name.startsWith(_pref+' '));
    const voice=_saved?voices.find(v=>v.name===_saved)||voices.find(v=>v.lang.startsWith(lang))||voices[0]:_prefVoice||voices.find(v=>v.lang.startsWith(lang)&&v.default)||voices.find(v=>v.lang.startsWith(lang))||voices[0];
    audioUtterRef.current=[];
    speechSynthesis.cancel();
    const sv=startVerse||(readVerses[0]?.verse||1);
    const startIdx=Math.max(0,readVerses.findIndex(v=>v.verse>=sv));
    const lastVerse=readVerses[readVerses.length-1]?.verse;
    for(let i=startIdx;i<readVerses.length;i++){
      const {verse,text}=readVerses[i];
      const u=new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g,''));
      u.voice=voice;u.rate=audioRate;
      u.onstart=()=>{currentVerseRef.current=verse;setCurrentVerse(verse);if(audioAutoScroll)scrollToVerse(verse);};
      u.onend=()=>{if(verse===lastVerse){audioModeRef.current=null;setAudioPlaying(false);setCurrentVerse(null);if(audioAutoAdvance)handleNextChapter();}};
      audioUtterRef.current.push(u);
    }
    setAudioLoaded(true);
    updateMediaSession(readBook,readCh);
    audioUtterRef.current.forEach(u=>speechSynthesis.speak(u));
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
  useEffect(()=>{try{localStorage.setItem('scrip:audio:voices',JSON.stringify(voicesByVersion));}catch{}},[voicesByVersion]);
  // ── Stop audio on chapter/version change ──
  useEffect(()=>{stopAudio();},[readVid,readBook,readCh]);
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
    navigator.mediaSession.setActionHandler('pause',()=>{audioElRef.current?.pause();speechSynthesis.pause();setAudioPlaying(false);});
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
    const onEnded=()=>{setAudioPlaying(false);if(audioAutoAdvance)handleNextChapter();};
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
            if(audioAutoScroll)scrollToVerse(vNum);
          }
          break;
        }
      }
    };
    el.addEventListener('play',onPlay);
    el.addEventListener('pause',onPause);
    el.addEventListener('ended',onEnded);
    el.addEventListener('timeupdate',onTimeUpdate);
    return()=>{
      el.removeEventListener('play',onPlay);
      el.removeEventListener('pause',onPause);
      el.removeEventListener('ended',onEnded);
      el.removeEventListener('timeupdate',onTimeUpdate);
    };
  },[audioAutoScroll,audioAutoAdvance]);
  // ── Sync rate with audio element ──
  useEffect(()=>{if(audioElRef.current)audioElRef.current.playbackRate=audioRate;},[audioRate]);
  // ── Sync rate with speech synthesis ──
  useEffect(()=>{
    audioUtterRef.current.forEach(u=>{u.rate=audioRate;});
  },[audioRate]);
  // ── Populate voice list when browser finishes loading voices ──
  useEffect(()=>{
    const onVoicesChanged=()=>setAvailableVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged',onVoicesChanged);
    // Populate immediately in case voices are already available (Firefox/Safari)
    const v=speechSynthesis.getVoices();
    if(v.length)setAvailableVoices(v);
    return()=>speechSynthesis.removeEventListener('voiceschanged',onVoicesChanged);
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
  // Measure bottom bar height
  useEffect(()=>{
    const measure=()=>{if(bottomBarRef.current)setBottomBarH(bottomBarRef.current.offsetHeight);};
    measure();
    const ro=new ResizeObserver(measure);
    if(bottomBarRef.current)ro.observe(bottomBarRef.current);
    window.addEventListener('resize',measure);
    return()=>{ro.disconnect();window.removeEventListener('resize',measure);};
  },[ready]);
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
    if(user.guest){
      const pd={versions:PUBLIC_VERSIONS,sections:[],entries:[]};
      setProjectId('guest-local');
      setData(pd);
      setReadVid(PUBLIC_VERSIONS.find(v=>v.isRef)?.id||PUBLIC_VERSIONS[0]?.id||'kjv');
      setParallelVids(PUBLIC_VERSIONS.map(v=>v.id));
      setBookmarks([]);setRecents([]);setBmCategories([]);
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
      dbLoadBookmarks(user.id).then(setBookmarks).catch(()=>{});
      dbLoadRecents(user.id).then(setRecents).catch(()=>{});
      dbLoadCategories(user.id).then(setBmCategories).catch(()=>{});
    })();
  },[user]);

  // ── Load reading chapter ──
  useEffect(()=>{
    if(!readVid||!ready)return;
    let cancelled=false;
    // If only the version changed (same book+chapter), preserve any highlighted verses
    const prev=prevReadStateRef.current;
    if(prev.vid&&prev.vid!==readVid&&prev.book===readBook&&prev.ch===readCh&&readSelVerses.size>0){
      readPendingSelVerses.current=new Set(readSelVerses);
    }
    prevReadStateRef.current={vid:readVid,book:readBook,ch:readCh};
    setReadSelVerses(new Set());
    // Close strip immediately so it doesn't flash empty while new chapter loads
    if(!readPendingSelVerses.current)setStripOpen(false);
    dbGetChapter(readVid,readBook,readCh).then(rows=>{
      if(!cancelled){
        setReadVerses(rows);
        if(readScrollToVerse.current){const tv=readScrollToVerse.current;readScrollToVerse.current=null;setTimeout(()=>{const el=document.getElementById(`rv-${tv}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(tv);return ns;});},80);}
        else{readRef.current?.scrollTo({top:0,behavior:'instant'});}
        if(readPendingSelVerses.current){const vs=readPendingSelVerses.current;readPendingSelVerses.current=null;setTimeout(()=>{const firstV=Math.min(...vs);const el=document.getElementById(`rv-${firstV}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(vs);setStripOpen(true);},80);}
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
  }

  // ── Keep scroll handler ref fresh every render ──
  scrollHandlerRef.current=(el)=>{
    onSearchScroll(el);
    if(tab==='read')handleReadScroll({target:el});
    // Show book scrubber on scroll, hide after 2.5s idle
    setScrubberVisible(true);
    clearTimeout(scrubberTimerRef.current);
    scrubberTimerRef.current=setTimeout(()=>setScrubberVisible(false),2500);
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
  function openFromBookmark(bm){
    setModal(null);
    setReadBook(bm.book_num);
    setReadCh(bm.chapter);
    setReadVid(bm.version_id);
    setTab('read');
    // Parse verse selection from label (e.g. "Genesis 1:3-5, 7") or fall back to single verse field
    const verses=new Set();
    try{
      // Try to extract range string after "BookName Ch:" from label
      const labelMatch=(bm.label||'').match(/:(.+)$/);
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
      if(bm.version_id===readVid&&bm.book_num===readBook&&bm.chapter===readCh){
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
  function openFromRecent(r){setModal(null);setReadBook(r.book_num);setReadCh(r.chapter);setReadVid(r.version_id);setTab('read');}

  async function doReadSearch(overrideQ,overrideOpts){
    const query=(overrideQ!==undefined?overrideQ:readSearchQ).trim();
    if(!query)return;
    if(overrideQ!==undefined)setReadSearchQ(overrideQ);
    setReadSearching(true);setReadSearchRes(null);setReadSearchResultsOpen(false);setReadSearchLimit(50);setReadSearchPopover(false);
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
      setReadSearchResultsOpen(true);
      setTimeout(()=>{if(readRef.current)readRef.current.scrollTop=0;},30);
      closeReadSheet();
    }catch(err){
      setReadSearchRes([]);
      setReadSearchResultsOpen(true);
      closeReadSheet();
    }finally{
      setReadSearching(false);
    }
  }
  async function doReadBookmark(){
    const sorted=[...readSelVerses].sort((a,b)=>a-b);
    const v=sorted[0];
    if(!user||!v)return;
    // Build range string e.g. "5-9" or "3, 5-7"
    const ranges=[];let i=0;
    while(i<sorted.length){let s=sorted[i],e=s;while(i+1<sorted.length&&sorted[i+1]===e+1){i++;e=sorted[i];}ranges.push(s===e?`${s}`:`${s}-${e}`);i++;}
    const rangeRef=`${bookName(readBk,versionLang(readVid))} ${readCh}:${ranges.join(', ')}`;
    await handleAddBookmark({versionId:readVid,bookNum:readBook,chapter:readCh,verse:v,label:readBmLabel||rangeRef,categoryId:readBmCat||null});
    setReadBmOk(true);setTimeout(()=>{setReadBmOk(false);setReadBmLabel('');setReadBmCat('');setReadBmLabelFocused(false);dismissStrip();},1800);
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
        const filename=prefix?name.slice(prefix.length):name;
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

  async function saveVersions(vers){
    setSaveStatus('saving');
    try{await dbSaveVersions(projectId,vers);setData(d=>({...d,versions:vers}));}
    catch(err){console.error('saveVersions:',err);}
    setModal(null);setSaveStatus('saved');
  }

  async function handleAddBookmark(params){
    if(!user)return;
    if(user.guest){
      const bm={id:'g-'+Date.now(),user_id:'guest',...params};
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
      setBookmarks([]);setRecents([]);setBmCategories([]);
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
  if(!authChecked)return(<div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg}}><style>{CSS}</style><Spinner/></div>);
  if(!user)return <AuthPanel onAuth={u=>setUser(u)}/>;
  if(recoveryMode)return <RecoveryPanel T={D} onDone={()=>setRecoveryMode(false)}/>;

  // ── Loading ──
  if(!ready||!data)return(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',background:D.bg}}>
      <style>{CSS}</style>
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
      <style>{CSS}</style>

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
      <div ref={navRef} className="no-print app-header" style={{background:T.bgCard,borderBottom:`1px solid ${T.bdA}`,padding:'calc(env(safe-area-inset-top,0px) + 12px) 6px 6px',position:'fixed',top:0,left:0,right:0,zIndex:200,touchAction:'none',userSelect:'none',WebkitUserSelect:'none'}}>
        <div style={{height:3,background:T.accentLine,position:'absolute',top:'env(safe-area-inset-top,0px)',left:0,right:0}}/>
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
                <button type="button" onClick={()=>{closeModal();if(readFullScreen.current)exitFullScreen();if(readMobileSheet)closeReadSheet();if(readSearchResultsOpen)setReadSearchResultsOpen(false);if(tab==='parallel'){const same=parallelBk===readBook&&parallelCh===readCh;setReadBook(parallelBk);setReadCh(parallelCh);readScrollToVerse.current=parallelVs;if(same){setTimeout(()=>{const el=document.getElementById(`rv-${parallelVs}`);if(el)el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(parallelVs);return ns;});readScrollToVerse.current=null;},80);}}setTab('read');}} style={{...nb(tab==='read'),flex:1,fontSize:10.5,fontWeight:tab==='read'?600:400,whiteSpace:'nowrap',padding:'0 12px'}}>&#10022; Read</button>
                <button type="button" onClick={()=>{if(readFullScreen.current)exitFullScreen();readMobileSheet==='studyTools'?closeReadSheet():setReadMobileSheet('studyTools');}} style={{...nb(studyActive),flex:1,fontSize:10.5,fontWeight:studyActive?600:400,whiteSpace:'nowrap',padding:'0 12px'}}>&#9998; Study</button>
              </div>
              {/* Tools pill: Search, Version, Navigate */}
              <div style={pill}>
                <button type="button" title="Search" onClick={tab==='compare'?()=>setMobileSheet('compareSearch'):!studyActive?()=>{if(readSearchRes&&!readSearchResultsOpen&&tab==='read'){if(readRef.current)readViewScrollRef.current=readRef.current.scrollTop;setReadSearchResultsOpen(true);setTimeout(()=>{if(readRef.current)readRef.current.scrollTop=searchResultScrollRef.current;},30);}else{readMobileSheet==='search'?closeReadSheet():setReadMobileSheet('search');}}:undefined} style={{...nb(tab==='compare'?!!q:!studyActive&&!!readSearchRes),width:44,fontSize:21,paddingLeft:2,visibility:tab==='compare'||!studyActive?'visible':'hidden'}}>
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
              {BIBLE.map(b=><option key={b.n} value={b.n}>{bookName(b,versionLang(readVid))}</option>)}
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
            {readSearchRes&&<button type="button" title="Clear search" onClick={()=>{setReadSearchRes(null);setReadSearchQ('');setReadSearchResultsOpen(false);}} style={{background:'none',border:'none',color:T.dim,fontSize:14,cursor:'pointer',flexShrink:0,lineHeight:1}}>✕</button>}
            {/* Settings button + popover */}
            <button type="button" title="Reading settings" onClick={()=>setReadSettingsOpen(v=>!v)}
              style={{height:33.33,boxSizing:'border-box',background:readSettingsOpen?T.gF:'none',border:`1px solid ${readSettingsOpen?T.gD:T.bd}`,borderRadius:6,color:readSettingsOpen?T.gT:T.dim,padding:'0 9px',flexShrink:0,fontSize:14,display:'flex',alignItems:'center',cursor:'pointer',transition:'all .15s'}}>⚙</button>
            {readSettingsOpen&&<>
              <div onClick={()=>setReadSettingsOpen(false)} style={{position:'fixed',inset:0,zIndex:499}}/>
              <div onClick={e=>e.stopPropagation()} style={{position:'absolute',top:'calc(100% + 8px)',right:0,zIndex:500,background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:10,padding:'16px 18px',width:260,boxShadow:'0 8px 32px rgba(0,0,0,0.28)'}}>
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
              <GhostBtn T={T} ch="§" onClick={()=>setModal({type:'about'})} title="About & Legal"/>
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
            {icon:'§',label:'About & Legal',fn:()=>{closeMobileSheet();setModal({type:'about'});}},
          ].map(item=>(
            <button key={item.label} type="button" className="s-btn s-ghost" onClick={item.fn}
              style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginBottom:6}}>
              <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>{item.icon}</span>{item.label}
            </button>
          ))}
          <div style={{height:1,background:T.bd,margin:'8px 0 10px'}}/>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:user?.guest?T.green:T.red,border:`1px solid ${user?.guest?T.greenTxt:T.redTxt}33`,borderRadius:9,color:user?.guest?T.greenTxt:T.redTxt,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%'}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>{user?.guest?'Log In':'Sign Out'}
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
        <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH} maxSheetHeight={`${window.innerHeight-navH-bottomBarH-8}px`}>
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
          {/* Read-tab toggles: Strong's + Auto Fullscreen */}
          {tab==='read'&&<div style={{display:'flex',gap:8,marginBottom:8}}>
            {/* Strong's card */}
            <div onClick={()=>readVid==='kjv'&&setStrongsMode(v=>!v)} title={readVid!=='kjv'?"Strong's numbers are only available for the KJV":undefined} style={{flex:1,padding:'9px 10px',background:strongsMode&&readVid==='kjv'?T.gF:T.bgSec,border:`1.5px solid ${strongsMode&&readVid==='kjv'?T.gD:T.bd}`,borderRadius:10,cursor:readVid==='kjv'?'pointer':'not-allowed',opacity:readVid==='kjv'?1:0.45,userSelect:'none',WebkitUserSelect:'none',transition:'background .2s,border-color .2s,opacity .2s',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:18,color:strongsMode&&readVid==='kjv'?T.gT:T.dim,flexShrink:0,transition:'color .2s'}}>ℍ</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:12,fontWeight:600,color:strongsMode&&readVid==='kjv'?T.mut:T.dim,transition:'color .2s'}}>Strong's</div>
                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>{readVid==='kjv'?'Hebrew & Greek':'KJV only'}</div>
              </div>
              {readVid==='kjv'&&<span onClick={e=>{e.stopPropagation();setStrongsInfoVisible(v=>!v);}} style={{fontSize:11,color:T.gM,cursor:'pointer',flexShrink:0,padding:'8px',margin:'-8px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>}
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
          {/* Bookmarks + Recent Passages cards -- always visible */}
          <div style={{display:'flex',gap:8,marginBottom:8}}>
            <div onClick={()=>{closeReadSheet();setModal({type:'bookmarks'});}} style={{flex:1,padding:'9px 10px',background:T.bgSec,border:`1.5px solid ${T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:18,color:T.gT,flexShrink:0}}>✦</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:12,fontWeight:600,color:T.mut}}>Bookmarks</div>
                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>Saved verses</div>
              </div>
            </div>
            <div onClick={()=>{closeReadSheet();setModal({type:'recents'});}} style={{flex:1,padding:'9px 10px',background:T.bgSec,border:`1.5px solid ${T.bd}`,borderRadius:10,cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',display:'flex',alignItems:'center',gap:8,minWidth:0}}>
              <span style={{fontFamily:FS,fontSize:18,color:T.gT,flexShrink:0}}>↺</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:FB,fontSize:12,fontWeight:600,color:T.mut}}>Recent Passages</div>
                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>History</div>
              </div>
            </div>
          </div>
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
          {settingsAppOpen&&<div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'14px 14px 10px',marginBottom:0}}>

            {/* Accent Color */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut}}>Accent Color</span>
                {accent==='custom'&&<button type="button" onClick={()=>{setAccent('gold');setCustomPickerOpen(false);}} style={{background:'transparent',border:'none',color:T.dim,fontFamily:FB,fontSize:12,padding:0,cursor:'pointer'}}>↺ Reset</button>}
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
                    : <span style={{fontSize:13,color:'rgba(255,255,255,0.95)',fontWeight:700,textShadow:'0 1px 4px rgba(0,0,0,0.8)',lineHeight:1,pointerEvents:'none'}}>+</span>
                  }
                </button>
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
          {/* ── AUDIO SETTINGS ── */}
          {tab==='read'&&(
          <button type="button" onClick={()=>setAudioSettingsOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:audioSettingsOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>♪</span>
            <span style={{flex:1,textAlign:'left'}}>Audio Playback</span>
            <span style={{fontSize:12,color:T.gM,transition:'transform .2s',display:'inline-block',transform:audioSettingsOpen?'rotate(180deg)':'rotate(0deg)'}}>▾</span>
          </button>
          )}

          {audioSettingsOpen&&tab==='read'&&<div style={{background:T.bgSec,border:`1px solid ${T.bd}`,borderTop:'none',borderRadius:'0 0 9px 9px',padding:'14px 14px 10px',marginBottom:0}}>

            {/* Auto-scroll + Auto-advance row */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',gap:4,marginBottom:audioInfoOpen?4:0}}>
                <button type="button" onClick={()=>{const v=!audioAutoScroll;setAudioAutoScroll(v);try{localStorage.setItem('scrip:audio:autoScroll',JSON.stringify(v));}catch{}}}
                  style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:audioAutoScroll?T.gF:'transparent',border:`1px solid ${audioAutoScroll?T.gD:T.bd}`,borderRadius:6,color:audioAutoScroll?T.gT:T.dim,fontFamily:FB,fontSize:12,padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                  <span>Auto-scroll</span>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <span style={{fontSize:9,opacity:0.7}}>{audioAutoScroll?'ON':'OFF'}</span>
                    <span onClick={e=>{e.stopPropagation();setAudioInfoOpen(v=>v==='scroll'?null:'scroll');}} style={{fontSize:11,color:T.gM,cursor:'pointer',lineHeight:1,userSelect:'none',WebkitUserSelect:'none',padding:'6px',margin:'-6px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>
                  </div>
                </button>
                <button type="button" onClick={()=>{const v=!audioAutoAdvance;setAudioAutoAdvance(v);try{localStorage.setItem('scrip:audio:autoAdvance',JSON.stringify(v));}catch{}}}
                  style={{flex:1,display:'flex',alignItems:'center',justifyContent:'space-between',background:audioAutoAdvance?T.gF:'transparent',border:`1px solid ${audioAutoAdvance?T.gD:T.bd}`,borderRadius:6,color:audioAutoAdvance?T.gT:T.dim,fontFamily:FB,fontSize:12,padding:'8px 10px',cursor:'pointer',transition:'all .12s'}}>
                  <span>Auto-advance</span>
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <span style={{fontSize:9,opacity:0.7}}>{audioAutoAdvance?'ON':'OFF'}</span>
                    <span onClick={e=>{e.stopPropagation();setAudioInfoOpen(v=>v==='advance'?null:'advance');}} style={{fontSize:11,color:T.gM,cursor:'pointer',lineHeight:1,userSelect:'none',WebkitUserSelect:'none',padding:'6px',margin:'-6px',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>ⓘ</span>
                  </div>
                </button>
              </div>
              {audioInfoOpen&&<div style={{background:T.bgCard,border:`1px solid ${T.bd}`,borderRadius:6,padding:'7px 10px',fontSize:11,fontFamily:FB,color:T.dim,lineHeight:1.5}}>
                {audioInfoOpen==='scroll'
                  ?'Automatically scrolls the page to keep the currently reading verse visible.'
                  :'Automatically loads and plays the next chapter when the current one ends.'}
              </div>}
            </div>

            {/* Playback Source */}
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:6}}>Source</div>
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <div style={{display:'flex',gap:4}}>
                  {[['auto','Auto'],['off','Off']].map(([k,l])=>(
                    <button key={k} type="button" onClick={()=>{setAudioSource(k);try{localStorage.setItem('scrip:audio:source',k);}catch{}}}
                      style={{flex:1,background:audioSource===k?T.gF:'transparent',border:`1px solid ${audioSource===k?T.gD:T.bd}`,borderRadius:6,color:audioSource===k?T.gT:T.dim,fontFamily:FB,fontSize:12,padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',height:'36px',boxSizing:'border-box',lineHeight:'1'}}>
                      {l}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={()=>{setAudioSource('local');try{localStorage.setItem('scrip:audio:source','local');}catch{}}}
                  style={{background:audioSource==='local'?T.gF:'transparent',border:`1px solid ${audioSource==='local'?T.gD:T.bd}`,borderRadius:audioSource==='local'&&Capacitor.isNativePlatform()?'6px 6px 0 0':'6px',color:audioSource==='local'?T.gT:T.dim,fontFamily:FB,fontSize:12,padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',height:'36px',boxSizing:'border-box',lineHeight:'1'}}>
                  KJV Audio{Capacitor.isNativePlatform()&&(!otInstalled||!ntInstalled)&&<span style={{fontFamily:FB,fontSize:9,color:T.dim,marginLeft:6}}>{otInstalled||ntInstalled?'· partial':'· import required'}</span>}
                </button>
                {audioSource==='local'&&Capacitor.isNativePlatform()&&(
                  <div style={{border:`1px solid ${T.gD}`,borderTop:'none',borderRadius:'0 0 6px 6px',padding:'10px',marginBottom:2}}>
                    {audioImport?(
                      <>
                        <div style={{fontFamily:FB,fontSize:12,color:T.mut,marginBottom:6}}>
                          Extracting {audioImport.pack==='OT'?'Old Testament':'New Testament'}...
                          {audioImport.total>0&&` (${audioImport.current} / ${audioImport.total})`}
                        </div>
                        {audioImport.total>0&&(
                          <div style={{height:4,background:T.bd,borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:'100%',width:`${Math.round((audioImport.current/audioImport.total)*100)}%`,background:T.gT,borderRadius:2,transition:'width .2s'}}/>
                          </div>
                        )}
                        {audioImport.error&&<div style={{fontFamily:FB,fontSize:11,color:'#ef5350',marginTop:6}}>{audioImport.error}</div>}
                      </>
                    ):(
                      <>
                        <div style={{display:'flex',gap:6,marginBottom:8}}>
                          {[{pack:'OT',label:'Old Testament',installed:otInstalled},{pack:'NT',label:'New Testament',installed:ntInstalled}].map(({pack,label,installed})=>(
                            <div key={pack} style={{flex:1,background:installed?'rgba(98,196,132,0.08)':T.bgCard,border:`1px solid ${installed?'#62c484':T.bd}`,borderRadius:6,padding:'8px'}}>
                              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:installed?0:6}}>
                                <span style={{fontFamily:FB,fontSize:11,color:installed?'#62c484':T.mut}}>{installed?'✓ ':''}{label}</span>
                                {installed&&<button onClick={()=>removeAudioPack(pack)} style={{background:'none',border:'none',color:T.dim,fontFamily:FB,fontSize:11,cursor:'pointer',padding:0}}>✕</button>}
                              </div>
                              {!installed&&(
                                <>
                                  <input id={`audiozip-${pack}`} type="file" accept=".zip" style={{display:'none'}}
                                    onChange={e=>{const f=e.target.files[0];if(f)importAudioZip(f,pack);e.target.value='';}}/>
                                  <button onClick={()=>document.getElementById(`audiozip-${pack}`).click()}
                                    style={{width:'100%',background:T.gF,border:`1px solid ${T.gD}`,borderRadius:4,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'6px 0',cursor:'pointer'}}>
                                    ↑ Import ZIP
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                        <div style={{fontFamily:FB,fontSize:11,color:T.dim,lineHeight:1.6}}>
                          Visit <a href="https://www.faithcomesbyhearing.com/audio-bible-resources/mp3-downloads?language=English&version=ENGKJVO1DA" target="_blank" rel="noreferrer" style={{color:T.gT}}>faithcomesbyhearing.com</a> and download the KJV OT and NT MP3 packs, then import each ZIP above.
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div style={{display:'flex',gap:4,alignItems:'center'}}>
                  <button type="button" onClick={()=>{setAudioSource('speech');try{localStorage.setItem('scrip:audio:source','speech');}catch{}}}
                    style={{flex:1,background:audioSource==='speech'?T.gF:'transparent',border:`1px solid ${audioSource==='speech'?T.gD:T.bd}`,borderRadius:6,color:audioSource==='speech'?T.gT:T.dim,fontFamily:FB,fontSize:12,padding:'8px 10px',cursor:'pointer',transition:'all .12s',textAlign:'left',lineHeight:'1',boxSizing:'border-box',height:'36px',whiteSpace:'nowrap'}}>
                    Browser Voice (any language)
                  </button>
                  <select value={voicesByVersion[readVid]||''} onChange={e=>{const name=e.target.value;setVoicesByVersion(prev=>{const next={...prev};if(name)next[readVid]=name;else delete next[readVid];return next;});}}
                    style={{flex:1,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:12,padding:'8px 4px',outline:'none',boxSizing:'border-box',lineHeight:'1',WebkitAppearance:'auto',appearance:'auto',height:'36px',overflow:'hidden'}}>
                    <option value="">Default for language</option>
                    {availableVoices.map((v,i)=><option key={i} value={v.name}>{v.name} ({v.lang})</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* FCBH API Key (if streaming selected) */}
            {audioSource==='fcbh'&&(
            <div style={{marginBottom:14}}>
              <div style={{fontFamily:FB,fontSize:14,color:T.mut,marginBottom:6}}>FCBH API Key</div>
              <input type="password" placeholder="Enter FCBH API key..."
                defaultValue={localStorage.getItem('scrip:audio:fcbhKey')||''}
                onBlur={e=>{try{localStorage.setItem('scrip:audio:fcbhKey',e.target.value);}catch{}}}
                style={{width:'100%',background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:12,padding:'8px 10px',outline:'none',boxSizing:'border-box'}}/>
              <div style={{fontFamily:FB,fontSize:11,color:T.dim,marginTop:6}}>Get free at <span style={{color:T.gT}}>bible.faithcomesbyhearing.com</span></div>
            </div>
            )}

            {/* Playback Speed */}
            <div style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut}}>Speed</span>
                <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.1em'}}>{audioRate.toFixed(2)}x</span>
              </div>
              <input type="range" min="0.5" max="2" step="0.25" value={audioRate}
                onChange={e=>{const v=Number(e.target.value);setAudioRate(v);try{localStorage.setItem('scrip:audio:rate',v);}catch{}}}
                style={{width:'100%',accentColor:T.gM,cursor:'pointer'}}/>
            </div>

            {audioError&&<div style={{padding:'10px 12px',background:'rgba(198,40,40,0.1)',border:`1px solid rgba(198,40,40,0.3)`,borderRadius:6,color:'#ef5350',fontFamily:FB,fontSize:12,marginBottom:14}}>
              {audioError}
            </div>}

          </div>}

          {/* ── Offline Data accordion ── */}
          <button type="button" onClick={()=>setOfflineDataOpen(o=>!o)}
            style={{display:'flex',alignItems:'center',gap:12,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:offlineDataOpen?'9px 9px 0 0':'9px',color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',cursor:'pointer',marginBottom:0,boxSizing:'border-box',transition:'border-radius .15s',marginTop:8}}>
            <span style={{width:22,display:'flex',alignItems:'center',justifyContent:'center',color:T.gT,flexShrink:0}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </span>
            <span style={{flex:1,textAlign:'left'}}>Offline Data</span>
            <span style={{fontSize:12,color:T.gM,transition:'transform .2s',display:'inline-block',transform:offlineDataOpen?'rotate(180deg)':'rotate(0deg)'}}>▾</span>
          </button>
          {offlineDataOpen&&(()=>{
            const offlineItems=[
              {id:'strongs',label:"Strong's Concordance",sub:'14,197 entries · Hebrew & Greek',icon:'ℍ'},
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
                {/* Downloaded bible versions */}
                {(data?.versions||[]).filter(v=>PUBLIC_VERSIONS.some(pv=>pv.id===v.id)).length>0&&(
                  <div style={{marginTop:8}}>
                    <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:6,paddingLeft:2}}>BIBLE VERSIONS</div>
                    <div style={{display:'flex',flexDirection:'column',gap:6}}>
                      {(data?.versions||[]).filter(v=>PUBLIC_VERSIONS.some(pv=>pv.id===v.id)).map(v=>{
                        const dl=dlStates[v.id]||{};
                        const pct=dl.total>0?Math.round((dl.progress/dl.total)*100):0;
                        return(
                          <div key={v.id} style={{background:T.bg,border:`1px solid ${T.bd}`,borderRadius:8,padding:'9px 12px'}}>
                            <div style={{display:'flex',alignItems:'center',gap:10}}>
                              <span style={{fontFamily:FS,fontSize:11,fontWeight:700,color:T.gT,width:45,textAlign:'center',flexShrink:0,letterSpacing:'0.04em'}}>{v.label}</span>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontFamily:FB,fontSize:13,fontWeight:600,color:T.mut}}>{v.label} Bible</div>
                                <div style={{fontFamily:FB,fontSize:10,color:T.dim}}>{v.lang} · {v.id.toUpperCase()}</div>
                              </div>
                              {dl.downloading?(
                                <span style={{fontFamily:FS,fontSize:10,color:T.gM,letterSpacing:'0.06em',flexShrink:0}}>{pct}%</span>
                              ):dl.downloaded?(
                                <button onClick={()=>deleteDownload(v.id)} style={{background:'none',border:`1px solid ${T.gD}`,borderRadius:6,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:9,letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>✓ Offline</button>
                              ):(
                                <button onClick={()=>startDownload(v.id)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.07em',padding:'4px 9px',cursor:'pointer',flexShrink:0}}>↓ Download</button>
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
                )}
              </div>
            );
          })()}
          <button type="button" className="s-btn s-ghost" onClick={()=>{closeReadSheet();setModal({type:'help'});}}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>⋯</span>Help & Reference
          </button>
          <button type="button" className="s-btn s-ghost" onClick={()=>{closeReadSheet();setModal({type:'about'});}}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.mut,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',color:T.gT,flexShrink:0}}>§</span>About & Legal
          </button>
          <button type="button" className="s-btn" onClick={()=>Auth.signOut()}
            style={{display:'flex',alignItems:'center',gap:12,textAlign:'left',background:user?.guest?T.green:T.red,border:`1px solid ${user?.guest?T.greenTxt:T.redTxt}33`,borderRadius:9,color:user?.guest?T.greenTxt:T.redTxt,fontFamily:FB,fontSize:18,padding:'13px 14px',width:'100%',marginTop:8}}>
            <span style={{width:22,textAlign:'center',flexShrink:0}}>→</span>{user?.guest?'Log In':'Sign Out'}
          </button>
          {user?.email&&<div style={{fontFamily:FB,fontSize:12,color:T.dim,textAlign:'center',marginTop:8,padding:'0 4px'}}>Signed in as <span style={{color:T.gM}}>{user.email}</span></div>}
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
                    {navStep==='book'?'Select Book':navStep==='chapter'?bookName(pickedBkData,versionLang(readVid))||'':`${bookName(pickedBkData,versionLang(readVid))||''} ${navPickedCh}`}
                  </div>
                  {navStep==='verse'&&(
                    <div style={{position:'absolute',right:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                      <button type="button" onClick={()=>{if(isP){setParallelVs(1);}closeReadSheet();}}
                        style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'6px 10px',cursor:'pointer',fontWeight:600,whiteSpace:'nowrap'}}>
                        Ch {navPickedCh} →
                      </button>
                    </div>
                  )}
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
                              {bookName(b,versionLang(readVid))}
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
                        else{if(readSearchResultsOpen)setReadSearchResultsOpen(false);setTimeout(()=>{const el=document.getElementById(`rv-${i+1}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(s=>{const ns=new Set(s);ns.add(i+1);return ns;});}},120);}
                        closeReadSheet();
                      }} style={gridBtn}>{i+1}</button>
                    ))}
                  </div>
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
                  <div style={{borderTop:`1px solid ${T.bd}`,marginTop:6,paddingTop:12}}>
                    <button type="button" onClick={openManageView}
                      style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:8,color:T.dim,fontFamily:FB,fontSize:14,padding:'10px 14px',cursor:'pointer',boxSizing:'border-box'}}>
                      <span style={{color:T.gM,display:'flex',alignItems:'center'}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span> Manage Bible Versions
                    </button>
                  </div>
                </>
              ):(
                <>
                  <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                      <button type="button" onClick={()=>setVersionSheetView('list')}
                        style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:7,color:T.gT,padding:'6px 9px',cursor:'pointer',fontSize:12,lineHeight:1,display:'flex',alignItems:'center',justifyContent:'center'}}>
                        ←
                      </button>
                    </div>
                    <div style={{fontFamily:FS,fontSize:22,fontWeight:700,color:T.gT,letterSpacing:'0.12em',textTransform:'uppercase'}}>Bible Versions</div>
                  </div>
                  {/* Current versions list */}
                  {manageVers.length===0&&<div style={{padding:'18px 0',textAlign:'center',fontFamily:FB,fontSize:15,color:T.dim}}>No versions added yet.</div>}
                  {manageVers.map((v,i)=>{
                    const dl=dlStates[v.id]||{};
                    const isBuiltin=PUBLIC_VERSIONS.some(pv=>pv.id===v.id);
                    return(
                      <div key={v.id} style={{padding:'11px 0',borderBottom:`1px solid ${T.bd}`}}>
                        <div style={{display:'flex',alignItems:'center',gap:12}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontFamily:FB,fontSize:16,color:T.body,fontWeight:500}}>{v.label}</div>
                            <div style={{fontFamily:FS,fontSize:8.5,color:T.dim,marginTop:2,letterSpacing:'0.08em'}}>{v.id} · {v.lang}{i===0?' · default':''}</div>
                          </div>
                          {isBuiltin&&startDownload&&(
                            dl.downloading?(
                              <span style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.08em',whiteSpace:'nowrap'}}>
                                {dl.total>0?`${Math.round((dl.progress/dl.total)*100)}%`:'…'}
                              </span>
                            ):dl.downloaded?(
                              <button onClick={()=>deleteDownload(v.id)} title="Remove offline copy" style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:5,color:T.greenTxt||'#62c484',fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                                ✓ Offline
                              </button>
                            ):(
                              <button onClick={()=>startDownload(v.id)} title="Download for offline use" style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:5,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'4px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>
                                ↓ Offline
                              </button>
                            )
                          )}
                          <button onClick={()=>manageRemove(v.id)} disabled={manageVers.length===1} style={{background:T.red,border:`1px solid ${T.redTxt}33`,borderRadius:5,color:T.redTxt,padding:'5px 11px',fontSize:13,cursor:manageVers.length===1?'default':'pointer',opacity:manageVers.length===1?0.4:1}}>✕</button>
                        </div>
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
                  {PUBLIC_VERSIONS.filter(pv=>!manageVers.find(v=>v.id===pv.id)).length>0&&(
                    <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.bd}`}}>
                      <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:10}}>BUILT-IN VERSIONS</div>
                      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                        {PUBLIC_VERSIONS.filter(pv=>!manageVers.find(v=>v.id===pv.id)).map(pv=>(
                          <button key={pv.id} onClick={()=>manageAddBuiltin(pv)} style={{background:T.gF,border:`1px solid ${T.gD}`,borderRadius:7,color:T.gT,fontFamily:FB,fontSize:15,padding:'8px 16px',cursor:'pointer'}}>＋ {pv.label}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Request a new version */}
                  <div style={{marginTop:20,paddingTop:16}}>
                    <div style={{fontFamily:FS,fontSize:8,color:T.gM,letterSpacing:'0.14em',marginBottom:8}}>REQUEST A VERSION</div>
                    <div style={{fontFamily:FB,fontSize:13,color:T.dim,lineHeight:1.7}}>To request a new Bible version or translation to be added to Scriptorium, please contact the app creator.</div>
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
          {readMobileSheet==='search'&&(
            <MobileSheet T={T} title={null} onClose={closeReadSheet} isClosing={readSheetClosing} fromTop topOffset={navH}>
              <div style={{position:'relative',marginBottom:14,minHeight:24,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{position:'absolute',left:0,top:0,bottom:0,display:'flex',alignItems:'center'}}>
                  <button type="button" onClick={()=>{closeReadSheet();}}
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

          {/* Search results header — floating pill below nav */}
          {readSearchRes&&tab==='read'&&!readMobileSheet&&!modal&&readSearchResultsOpen&&(
            <div className="srch-bar-fixed" style={{position:'fixed',top:navH+8,left:14,right:14,zIndex:210,
              display:'flex',alignItems:'center',gap:8,padding:'7px 10px',
              background:'transparent',border:`1px solid ${T.bd}`,borderRadius:8,
              backdropFilter:'blur(10px)',WebkitBackdropFilter:'blur(10px)',
              boxShadow:'0 4px 18px rgba(0,0,0,0.18)'}}>
              <button type="button" onClick={()=>{if(readRef.current)searchResultScrollRef.current=readRef.current.scrollTop;setReadSearchResultsOpen(false);setTimeout(()=>{if(readRef.current)readRef.current.scrollTop=readViewScrollRef.current;},30);}}
                style={{display:'flex',alignItems:'center',gap:5,background:'rgba(228,204,120,0.08)',border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',fontWeight:600,padding:'5px 11px',cursor:'pointer',flexShrink:0,whiteSpace:'nowrap',transition:'all .15s'}}>
                ← Back to Reading
              </button>
              <div style={{fontFamily:FS,fontSize:9,color:T.gM,letterSpacing:'0.08em',fontWeight:500,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}}>
                <span>{readSearchRes.length} verse{readSearchRes.length!==1?'s':''}</span>
                <span style={{color:T.dim}}> · {readSearchOccurrences} occurrence{readSearchOccurrences!==1?'s':''}</span>
                <span style={{color:T.dim}}> for "{readSearchQ}"</span>
              </div>
            </div>
          )}


          {/* Custom overlay scrollbar thumb */}
          <div ref={scrollbarThumbRef} className="read-scrollbar"/>

          {/* Fixed audio overlay button */}
          {audioSource!=='off'&&(!readSearchRes||!readSearchResultsOpen)&&(
            <button type="button" disabled={audioLoading}
              onClick={()=>{
                const packInstalled=readBook<=39?otInstalled:ntInstalled;
                if(readVid==='kjv'&&!packInstalled&&!kjvPromptShownRef.current&&!localStorage.getItem('scrip:audio:kjvPromptDismissed')){kjvPromptShownRef.current=true;setKjvPromptNoShow(false);setShowKjvAudioPrompt(true);return;}
                if(audioPlaying){audioElRef.current?.pause();speechSynthesis.pause();setAudioPlaying(false);if(stripOpen)dismissStrip();return;}
                const hasFcbhKey=!!(localStorage.getItem('scrip:audio:fcbhKey')||'').trim();
                const src=audioSource==='auto'?(readVid==='kjv'?'local':DEFAULT_FILESETS[readVid]&&hasFcbhKey?'fcbh':'speech'):(audioSource==='off'?null:audioSource);
                if(src==='speech'){
                  const sv=readSelVerses.size>0?Math.min(...readSelVerses):(readVerses[0]?.verse||1);
                  if(audioLoaded&&speechSynthesis.paused){speechSynthesis.resume();setAudioPlaying(true);}
                  else{doStartSpeech(sv);}
                  return;
                }
                (audioLoaded&&(audioModeRef.current==='fcbh'||audioModeRef.current==='local'))?handlePlayPause():loadChapterAudio();
              }}
              style={{position:'fixed',top:readFullScreen.current?Math.max(4,navH-44):Math.max(8,navH+8),right:14,zIndex:140,display:'flex',alignItems:'center',gap:0,padding:(audioPlaying||audioLoading||audioLoaded)?'7px 12px':'7px 9px',background:'transparent',border:`1px solid ${audioPlaying||audioLoaded?T.gD:T.bd}`,borderRadius:6,color:audioPlaying||audioLoaded?T.gT:T.dim,cursor:audioLoading?'wait':'pointer',fontFamily:FB,fontSize:12,transition:'all .22s ease',backdropFilter:'blur(4px)',WebkitBackdropFilter:'blur(4px)',flexShrink:0,overflow:'hidden',boxShadow:'0 4px 18px rgba(0,0,0,0.18)',opacity:!audioPlaying&&audioLoaded&&!audioLoading?0.72:1}}>
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
                  <div style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.08em',marginBottom:14,textAlign:'center'}}>KJV Audio</div>
                  <div style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.7,marginBottom:20}}>
                    Currently using your device's built-in voice. For a professional audio Bible reading, download the free KJV MP3 pack in <span style={{color:T.gT,fontWeight:500}}>Settings → Audio Playback → KJV Audio</span>.
                  </div>
                  <label style={{display:'flex',alignItems:'center',gap:10,marginBottom:20,cursor:'pointer'}}>
                    <input type="checkbox" checked={kjvPromptNoShow} onChange={e=>setKjvPromptNoShow(e.target.checked)} style={{width:16,height:16,accentColor:T.g,cursor:'pointer'}}/>
                    <span style={{fontFamily:FB,fontSize:13,color:T.dim}}>Don't show this again</span>
                  </label>
                  <div style={{display:'flex',gap:10}}>
                    <button type="button" onClick={()=>{if(kjvPromptNoShow)localStorage.setItem('scrip:audio:kjvPromptDismissed','true');setShowKjvAudioPrompt(false);setReadMobileSheet('settings');setAudioSettingsOpen(true);}}
                      style={{flex:1,background:'none',border:`1px solid ${T.bd}`,borderRadius:8,color:T.gM,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',padding:'10px 0',cursor:'pointer'}}>
                      Go to Settings
                    </button>
                    <button type="button" onClick={()=>{if(kjvPromptNoShow)localStorage.setItem('scrip:audio:kjvPromptDismissed','true');setShowKjvAudioPrompt(false);const sv=readSelVerses.size>0?Math.min(...readSelVerses):(readVerses[0]?.verse||1);doStartSpeech(sv);}}
                      style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.1em',fontWeight:600,padding:'10px 0',cursor:'pointer'}}>
                      Play Anyway
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Verse content */}

          <div ref={readRef} className="read-area" style={{flex:1,overflowY:'auto',padding:`${(readSearchRes&&readSearchResultsOpen)?navH+72:navH+8}px 5px 64px`,maxWidth:960,margin:'0 auto',width:'100%',boxSizing:'border-box'}}
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
          {(!readSearchRes||!readSearchResultsOpen)&&(
            <div style={{padding:'10px 12px 2px'}}>
              <div style={{textAlign:'center',fontFamily:FS,fontSize:9,letterSpacing:'0.28em',textTransform:'uppercase',color:T.gM,marginBottom:2,fontWeight:500}}>{readVerLabel}</div>
              <div style={{position:'relative',display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{fontFamily:FS,fontSize:19,fontWeight:600,color:T.gT,letterSpacing:'0.06em',textAlign:'center'}}>{bookName(readBk,versionLang(readVid))} {readCh}</div>
              </div>
              <div style={{height:1,background:T.accentLine,marginTop:8}}/>
            </div>
          )}
            {readSearchRes&&readSearchResultsOpen&&(
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
                    <div style={{position:'fixed',right:0,top:navH+(readSearchRes?62:12),bottom:bottomBarH+12,transform:`translateX(${scrubberVisible?'0':'110%'})`,zIndex:200,
                      display:'flex',flexDirection:'column',alignItems:'center',
                      background:dark?'rgba(28,23,12,0.18)':'rgba(248,243,228,0.18)',
                      borderRadius:'10px 0 0 10px',padding:'6px 2px',gap:0,
                      overflowY:'auto',
                      boxShadow:'-2px 0 14px rgba(0,0,0,0.22)',backdropFilter:'blur(6px)',
                      transition:'transform .3s cubic-bezier(0.4,0,0.2,1)'}}>
                      {booksInRes.map(bn=>{
                        const nm=bookName(BIBLE.find(x=>x.n===bn),versionLang(readVid))||'?';
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
                  <div key={`${r.book_num}-${r.chapter}-${r.verse}`} id={firstOfBook?`srch-bk-${r.book_num}`:undefined} className="reading-verse s-btn" onClick={()=>{if(readRef.current)searchResultScrollRef.current=readRef.current.scrollTop;setReadSearchResultsOpen(false);const sameChap=(r.book_num===readBook&&r.chapter===readCh);if(sameChap){setTimeout(()=>{const el=document.getElementById(`rv-${r.verse}`);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});setReadSelVerses(new Set([r.verse]));}},50);}else{readScrollToVerse.current=r.verse;setReadBook(r.book_num);setReadCh(r.chapter);}}} style={{padding:'10px 12px',marginBottom:6,borderRadius:6,border:`1px solid ${T.bd}`,background:T.bgCard,cursor:'pointer'}}>
                    <div style={{fontFamily:FS,fontSize:10,color:T.gM,marginBottom:4,letterSpacing:'0.08em',fontWeight:500}}>{bookName(b,versionLang(readVid))} {r.chapter}:{r.verse}</div>
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
            {(!readSearchRes||!readSearchResultsOpen)&&readVerses.length===0&&(
              <div style={{textAlign:'center',padding:'48px 0',color:T.dim,fontFamily:FB,fontStyle:'italic',fontSize:15}}>
                No verses found. Download a version for offline use via the Compare tab &gt; Versions.
              </div>
            )}
            {strongsMode&&readVid!=='kjv'&&(!readSearchRes||!readSearchResultsOpen)&&(
              <div style={{margin:'8px 8px 0',padding:'8px 14px',borderRadius:7,border:`1px solid ${T.gD}`,background:T.gF,display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:T.gT,fontSize:14,flexShrink:0}}>ℍ</span>
                <span style={{fontFamily:FB,fontSize:13,color:T.gM,lineHeight:1.4}}>Strong's mode is only available for KJV.</span>
              </div>
            )}
            {(!readSearchRes||!readSearchResultsOpen)&&readVerses.length>0&&(
              readParaMode?(
                <div style={{textAlign:readTextAlign,padding:'3px 4px'}}>
                  {readVerses.map(({verse:v,text})=>{
                    const sel=!audioPlaying&&readSelVerses.has(v);
                    const isAudio=audioPlaying&&currentVerse===v;
                    return(
                      <span key={v} data-verse={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={()=>verseTouchEnd(v)}
                        onClick={()=>{if(audioPlaying){if(audioModeRef.current==='speech'){seekWebSpeechToVerse(v);}else{const _ts=audioTimestampsRef.current;if(_ts&&_ts[v]!==undefined&&audioElRef.current){audioElRef.current.currentTime=_ts[v];currentVerseRef.current=v;setCurrentVerse(v);}}}else{verseClick(v);}}}
                        style={{cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',background:isAudio?'var(--ac-audio-bg)':sel?T.gF:'transparent',borderRadius:isAudio?4:sel?Math.round(readFontSize*0.15):0,padding:sel?`${Math.round(readFontSize*0.08)}px ${Math.round(readFontSize*0.1)}px`:0,boxShadow:sel?`0 0 0 ${Math.max(1,Math.round(readFontSize*0.04))}px ${T.gD}`:'none',transition:'all .2s'}}>
                        {readVerseNums==='super'&&<sup style={{fontFamily:FS,fontSize:Math.round(readFontSize*0.45),color:sel?T.gT:T.gM,marginRight:2,fontWeight:600}}>{v}</sup>}
                        {readVerseNums==='inline'&&<span style={{fontFamily:FS,fontSize:10,color:sel?T.gT:T.gM,marginRight:6,fontWeight:600}}>{v}</span>}
                        <span className="rv-text" style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,textDecoration:isAudio&&readParaMode?'underline':'none',textDecorationColor:isAudio?'var(--ac-audio-line)':'transparent'}}>
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
                    const sel=!audioPlaying&&readSelVerses.has(v);
                    const isAudio=audioPlaying&&currentVerse===v;
                    return(
                      <div key={v} data-verse={v} id={`rv-${v}`} className="reading-verse"
                        onTouchStart={e=>verseTouchStart(v,e)} onTouchMove={e=>verseTouchMove(e)} onTouchEnd={()=>verseTouchEnd(v)}
                        onClick={()=>{if(audioPlaying){if(audioModeRef.current==='speech'){seekWebSpeechToVerse(v);}else{const _ts=audioTimestampsRef.current;if(_ts&&_ts[v]!==undefined&&audioElRef.current){audioElRef.current.currentTime=_ts[v];currentVerseRef.current=v;setCurrentVerse(v);}}}else{verseClick(v);}}}
                        style={{padding:'2px 4px',cursor:'pointer',userSelect:'none',WebkitUserSelect:'none',borderRadius:5,background:isAudio?'var(--ac-audio-bg)':sel?T.gF:'transparent',boxShadow:isAudio?`0 0 0 1.5px var(--ac-audio-ring)`:sel?`0 0 0 1.5px ${T.gD}, 0 1px 6px var(--ac-sel-glow)`:'none',marginBottom:1,transition:'all .2s'}}>
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
            {(!readSearchRes||!readSearchResultsOpen)&&readVerses.length>0&&(
              <div style={{paddingTop:64,paddingBottom:8,textAlign:'center'}}>
                <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.22em',textTransform:'uppercase',color:T.gD,fontWeight:500}}>
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
                const num=m[1];
                parts.push(React.createElement('span',{key:m.index,onClick:e=>{e.stopPropagation();loadStrongsEntry(num);},style:{color:T.gT,cursor:'pointer',fontWeight:600,textDecoration:'underline dotted'}},num));
                last=m.index+num.length;
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

            return React.createElement('div',{onClick:closeStrongsPopup,style:{position:'fixed',inset:0,zIndex:140,background:'rgba(0,0,0,0.2)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:navH+100,animation:strongsClosing?'backdropOut .26s ease both':'backdropIn .15s ease both'}},
              React.createElement('div',{onClick:e=>e.stopPropagation(),style:{background:T.bg,borderRadius:16,borderTop:`2px solid ${T.bdA}`,width:'100%',maxWidth:520,maxHeight:`calc(100vh - ${navH}px - 150px)`,overflow:'hidden',display:'flex',flexDirection:'column',boxShadow:'0 8px 48px rgba(0,0,0,0.5)',marginBottom:bottomBarH+20,willChange:'transform',animation:strongsClosing?'sheetClose .26s cubic-bezier(0.4,0,1,1) both':'sheetOpen .38s cubic-bezier(0.22,1,0.36,1) both'}},
              React.createElement('div',{style:{height:3,background:T.accentLine,flexShrink:0}}),
              React.createElement('div',{style:{overflow:'auto',padding:'20px 20px 32px',flex:1,display:'flex',flexDirection:'column',minHeight:0}},
                React.createElement('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}},
                  React.createElement('div',{style:{display:'flex',alignItems:'center',gap:8}},
                    (strongsPopup.history||[]).length>0&&React.createElement('button',{onClick:e=>{e.stopPropagation();goBackStrongs();},style:{background:'none',border:'none',color:T.gT,cursor:'pointer',fontSize:16,padding:'0 4px 0 0',fontFamily:FB,fontWeight:600}},'‹ Back'),
                    React.createElement('span',{style:{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:T.gT,fontWeight:600}},strongsPopup.strongs_number),
                    totalCount>0&&React.createElement('span',{style:{fontFamily:FB,fontSize:12,color:T.dim,background:T.bgCH,borderRadius:10,padding:'2px 7px'}},`×${totalCount}`)
                  ),
                  React.createElement('button',{onClick:closeStrongsPopup,style:{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:18}},'✕')
                ),
                strongsPopup.entry?(
                  React.createElement('div',null,
                    React.createElement('div',{style:{fontSize:Math.max(24,Math.round(readFontSize*1.1)),color:T.body,marginBottom:4,fontFamily:fontFamilyMap[readFontFamily]}},strongsPopup.entry.original_word),
                    React.createElement('div',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,marginBottom:2}},strongsPopup.entry.transliteration+(strongsPopup.entry.pronunciation?` (${strongsPopup.entry.pronunciation})`:'')),
                    React.createElement('div',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim,marginBottom:12,fontStyle:'italic'}},strongsPopup.entry.language==='hebrew'?'Hebrew':'Greek'),
                    React.createElement('div',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,marginBottom:12}},strongsPopup.entry.short_def),
                    strongsPopup.entry.full_def&&React.createElement('div',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,lineHeight:readLineHeight,marginBottom:12}},renderDerivation(strongsPopup.entry.full_def)),
                    groupList.length>0&&React.createElement('div',{style:{borderTop:`1px solid ${T.bd}`,paddingTop:10,marginTop:4,marginBottom:20}},
                      React.createElement('div',{style:{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',color:T.gM,marginBottom:4}},'KJV USAGE'),
                      React.createElement('div',{style:{fontFamily:FS,fontSize:10,letterSpacing:'0.08em',color:T.dim,marginBottom:8}},`Total KJV Occurrences (×${totalCount})`),
                      groupList.map(([key,{word,refs}])=>{
                        const isExpanded=strongsExpandedWords.has(key);
                        const refArr=[...refs.entries()].map(([r,cnt])=>{const[bn,ch,vs]=r.split('|').map(Number);return{bn,ch,vs,cnt};}).sort((a,b)=>a.bn-b.bn||a.ch-b.ch||a.vs-b.vs);
                        const getBookName=bn=>bookName(BIBLE[bn-1],versionLang(readVid));
                        return React.createElement('div',{key,style:{marginBottom:8}},
                          React.createElement('div',{onClick:()=>setStrongsExpandedWords(s=>{const ns=new Set(s);ns.has(key)?ns.delete(key):ns.add(key);return ns;}),
                            style:{display:'flex',alignItems:'center',gap:6,cursor:'pointer',padding:'4px 0'}},
                            React.createElement('span',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,fontWeight:600}},word),
                            React.createElement('span',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim}},`(×${[...refs.values()].reduce((s,c)=>s+c,0)})`),
                            React.createElement('span',{style:{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.76),color:T.dim,marginLeft:'auto'}},isExpanded?'▴':'▾')
                          ),
                          isExpanded&&React.createElement('div',{style:{paddingLeft:8,paddingBottom:4}},
                            refArr.map(({bn,ch,vs,cnt})=>
                              React.createElement('span',{key:`${bn}-${ch}-${vs}`,onClick:e=>{e.stopPropagation();openStrongsVersePreview(bn,ch,vs);},
                                style:{display:'inline-block',fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.gT,cursor:'pointer',marginRight:10,marginBottom:4,textDecoration:'underline dotted'}},
                                `${getBookName(bn)} ${ch}:${vs}`+(cnt>1?` ×${cnt}`:''))
                            )
                          )
                        );
                      })
                    ),
                    groupList.length===0&&strongsPopup.versesLoading&&React.createElement('div',{style:{fontFamily:FB,fontSize:13,color:T.dim,paddingTop:8}},'Loading verses…'),
                    React.createElement('div',{style:{textAlign:'center',paddingTop:24,paddingBottom:8,borderTop:`1px solid ${T.bd}`,marginTop:16}},
                      React.createElement('div',{style:{fontSize:24,color:T.gM,marginBottom:6}},'·'),
                      React.createElement('div',{style:{fontFamily:FB,fontSize:11,color:T.dim,letterSpacing:'0.06em'}},'End of entry')
                    )
                  )
                ):(
                  React.createElement('div',{style:{textAlign:'center',padding:20,color:T.dim,fontFamily:FB}},'Loading...')
                )
              )
            )
          );
          })()}

          {strongsVersePreview&&(
            <div onClick={()=>setStrongsVersePreview(null)} style={{position:'fixed',inset:0,zIndex:250,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(8px)',WebkitBackdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px 20px',animation:'fadeIn .15s ease both'}}>
              <div onClick={e=>e.stopPropagation()} style={{background:T.bg,borderRadius:16,width:'100%',maxWidth:440,maxHeight:'60vh',overflow:'auto',padding:'20px 20px 28px',boxShadow:'0 8px 40px rgba(0,0,0,0.6)'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                  <button onClick={()=>setStrongsVersePreview(null)} style={{background:'none',border:'none',color:T.gT,cursor:'pointer',fontFamily:FB,fontSize:22,fontWeight:600,padding:'0 8px 0 0',lineHeight:1}}>‹</button>
                  <span style={{fontFamily:FS,fontSize:12,letterSpacing:'0.12em',color:T.gT,fontWeight:600,flex:1,textAlign:'center'}}>{strongsVersePreview.label}</span>
                  <button onClick={()=>{setReadBook(strongsVersePreview.bn);setReadCh(strongsVersePreview.ch);setStrongsPopup(null);setStrongsVersePreview(null);setTab('read');}} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,cursor:'pointer',fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'4px 10px',fontWeight:600}}>Go</button>
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
          {stripOpen&&tab==='read'&&(!readSearchRes||!readSearchResultsOpen)&&!audioPlaying&&(
            <div className={stripClosing?'slide-down-strip':'slide-up-strip'} style={{position:'fixed',bottom:fsActive?Math.max(0,bottomBarH-50):Math.max(0,bottomBarH+8),left:14,right:14,zIndex:135,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:8,backdropFilter:'blur(10px)',WebkitBackdropFilter:'blur(10px)',padding:'7px 10px',display:'flex',alignItems:'center',height:'auto',minHeight:44,boxSizing:'border-box',transition:'bottom .18s ease',boxShadow:'0 4px 18px rgba(0,0,0,0.18)'}}>
              {readBmOk
                ?<span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:'#62c484',fontWeight:600,flex:1,textAlign:'center'}}>✓ Bookmarked</span>
                :readCopyOk
                  ?<span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:'#62c484',fontWeight:600,flex:1,textAlign:'center'}}>✓ Copied</span>
                  :<div style={{display:'flex',flexDirection:'column',gap:6,width:'100%'}}>
                    {/* Row 1: verse badge + [category] + Bookmark + Copy fill evenly + dismiss */}
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontFamily:FS,fontSize:11,color:T.gT,letterSpacing:'0.08em',fontWeight:600,flexShrink:0,background:'rgba(228,204,120,0.08)',border:`1px solid ${T.gD}`,borderRadius:6,padding:'0 10px',height:30,boxSizing:'border-box',display:'flex',alignItems:'center',whiteSpace:'nowrap'}}>
                        {(()=>{const a=[...readSelVerses].sort((a,b)=>a-b);const r=[];let i=0;while(i<a.length){let j=i;while(j+1<a.length&&a[j+1]===a[j]+1)j++;r.push(j>i?`${a[i]}-${a[j]}`:String(a[i]));i=j+1;}return `${bookName(readBk,versionLang(readVid))} ${readCh}:${r.join(', ')}`;})()}
                      </span>
                      {user&&bmCategories.length>0&&<select value={readBmCat} onChange={e=>setReadBmCat(e.target.value)}
                        style={{flex:1,minWidth:0,height:30,background:'rgba(228,204,120,0.06)',border:`1px solid ${T.gD}`,borderRadius:6,color:readBmCat?T.gT:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.05em',padding:'0 6px',outline:'none',cursor:'pointer',boxSizing:'border-box'}}>
                        <option value="">category…</option>
                        {bmCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>}
                      {user
                        ?<button type="button" className="s-btn s-ghost" onClick={()=>{setBmHover(false);doReadBookmark();}}
                          onMouseEnter={()=>setBmHover(true)} onMouseLeave={()=>setBmHover(false)}
                          style={{flex:1,background:bmHover?'rgba(228,204,120,0.15)':'rgba(228,204,120,0.08)',border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.06em',padding:'0',fontWeight:600,cursor:'pointer',height:30,boxSizing:'border-box',transition:'all .15s',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                          <span>✦</span><span>Bookmark</span>
                        </button>
                        :<span style={{flex:1,fontFamily:FB,fontStyle:'italic',color:T.gM,fontSize:12,textAlign:'center'}}>Sign in to bookmark</span>}
                      <button type="button" className="s-btn s-ghost" onClick={()=>{setCopyHover(false);copySelectedVerses();}}
                        onMouseEnter={()=>setCopyHover(true)} onMouseLeave={()=>setCopyHover(false)}
                        style={{flex:1,background:copyHover?'rgba(228,204,120,0.15)':'rgba(228,204,120,0.08)',border:`1px solid ${T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.06em',padding:'0',fontWeight:600,height:30,boxSizing:'border-box',transition:'all .15s',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                        <span>⧉</span><span>Copy</span>
                      </button>
                      <button type="button" onClick={dismissStrip}
                        style={{background:'rgba(200,60,60,0.05)',border:'1px solid rgba(200,60,60,0.22)',borderRadius:6,color:'#b86060',cursor:'pointer',fontSize:13,fontWeight:600,flexShrink:0,width:32,height:30,display:'flex',alignItems:'center',justifyContent:'center',lineHeight:1,boxSizing:'border-box',transition:'all .15s',padding:0}}>✕</button>
                    </div>
                    {/* Row 2: Bookmark notes — full width */}
                    <div style={{display:'flex',width:'100%'}}>
                      <textarea value={readBmLabel} onChange={e=>setReadBmLabel(e.target.value)}
                        onFocus={()=>setReadBmLabelFocused(true)} onBlur={()=>setReadBmLabelFocused(false)}
                        placeholder="Bookmark notes…" rows={1}
                        style={{flex:1,minWidth:0,background:'rgba(228,204,120,0.06)',border:`1px solid ${readBmLabelFocused?T.gT:T.gD}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:readBmLabelFocused?14:10,letterSpacing:'0.05em',padding:readBmLabelFocused?'10px':'0 8px',outline:'none',height:readBmLabelFocused?140:30,boxSizing:'border-box',resize:'none',overflow:readBmLabelFocused?'auto':'hidden',lineHeight:readBmLabelFocused?1.6:'30px',transition:'height 0.22s ease, font-size 0.18s ease, padding 0.18s ease, border-color 0.15s ease'}}/>
                    </div>
                  </div>
              }
            </div>
          )}

          {/* Bottom nav */}
          <div ref={bottomBarRef} className="bottom-nav-safe" style={{position:'fixed',bottom:0,left:0,right:0,zIndex:150,background:T.bgCard,borderTop:`1px solid ${T.bdS}`,padding:'5px 12px 0 12px',display:'flex',justifyContent:'space-between',alignItems:'center',minHeight:49,boxSizing:'border-box'}}>
              <button type="button" className="s-btn s-ghost" onClick={readPrevCh} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',fontWeight:500,width:90,height:34,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {'\u2039'} {readCh>1?`Ch ${readCh-1}`:readBook>1?bookName(BIBLE.find(b=>b.n===readBook-1),versionLang(readVid)):''}
              </button>
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                <span style={{fontFamily:FS,fontSize:11,letterSpacing:'0.08em',color:T.gT,fontWeight:500,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',textTransform:'uppercase'}}>
                  {bookName(BIBLE.find(b=>b.n===readBook),versionLang(readVid))||''} {readCh}
                </span>
              </div>
              <button type="button" className="s-btn s-ghost" onClick={readNextCh} style={{background:'none',border:`1px solid ${T.bd}`,borderRadius:6,color:T.gT,fontFamily:FS,fontSize:11,letterSpacing:'0.08em',fontWeight:500,width:90,height:34,overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',flexShrink:0}}>
                {readCh<readTotalCh?`Ch ${readCh+1}`:readBook<66?bookName(BIBLE.find(b=>b.n===readBook+1),versionLang(readVid)):''} {'\u203a'}
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

          {/* Sticky controls */}
          <div className="no-print" style={{background:T.bgCard,borderBottom:`1px solid ${T.bd}`,position:'sticky',top:0,zIndex:50,flexShrink:0}}>

            {/* Unified toolbar — desktop only */}
            <div className="hide-mobile" style={{display:'flex',alignItems:'center',gap:5,padding:'5px 8px',flexWrap:'nowrap',overflowX:'auto',WebkitOverflowScrolling:'touch'}}>
              <span style={{color:T.gM,fontSize:14,flexShrink:0}}>⌕</span>
              <input className="s-btn" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search passages, text, notes…"
                style={{flex:1,minWidth:120,background:T.bgIn,border:`1px solid ${T.bd}`,borderRadius:6,color:T.body,fontFamily:FB,fontSize:14,padding:'5px 8px',outline:'none'}}/>
              {q&&<button type="button" className="s-btn s-ghost" title="Clear search" onClick={()=>setQ('')} style={{background:'none',border:'none',color:T.dim,fontSize:13,padding:'2px 4px',flexShrink:0}}>✕</button>}
              <div style={{width:1,height:18,background:T.bd,flexShrink:0,margin:'0 2px'}}/>
              <TBtn T={T} ch="＋ Verse" onClick={openAdd} primary/>
              <TBtn T={T} ch="＋ Section" onClick={openAddSec}/>
              <TBtn T={T} ch="▾" onClick={()=>setSecToggle({action:'expand',tick:Date.now()})} title="Expand all"/>
              <TBtn T={T} ch="▴" onClick={()=>setSecToggle({action:'collapse',tick:Date.now()})} title="Collapse all"/>
            </div>

            {/* Mobile action row */}
            <div className="show-mobile" style={{display:'flex',alignItems:'center',gap:6,padding:'6px 10px',borderBottom:`1px solid ${T.bdS}`}}>
              <button type="button" onClick={openAdd}
                style={{flex:1,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:8,color:T.gT,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'8px 0',cursor:'pointer',fontWeight:700,textAlign:'center'}}>
                ＋ Add Verse
              </button>
              <button type="button" onClick={openAddSec}
                style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:8,color:T.mut,fontFamily:FS,fontSize:9,letterSpacing:'0.08em',padding:'8px 0',cursor:'pointer',fontWeight:500,textAlign:'center'}}>
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
                    <Section key={sec.id} sec={sec} entries={data.entries.filter(e=>e.sectionId===sec.id)} versions={visibleVersions} q={q} dark={dark} T={T} onEditSec={openEditSec} onDelSec={openDelSec} onEdit={openEdit} onDup={openDup} onDel={openDelEntry} pulseId={pulseId} secToggle={secToggle} idx={si} isFirst={si===0} isLast={si===data.sections.length-1} onMoveUp={()=>moveSection(sec.id,'up')} onMoveDown={()=>moveSection(sec.id,'down')} onRead={jumpToFromCard} readFontSize={readFontSize} readLineHeight={readLineHeight} readFontFamily={readFontFamily}/>
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
                const num=m[1];
                parts.push(<span key={m.index} onClick={()=>{
                  setStrongsTabEntry({strongs_number:num,entry:null,verses:null});
                  Promise.all([dbGetStrongsEntry(num),dbGetStrongsVerses(num)]).then(([entry,vv])=>{
                    setStrongsTabEntry(prev=>prev&&prev.strongs_number===num?{strongs_number:num,entry,verses:vv}:prev);
                  });
                  setStrongsSearchQ(num);
                }} style={{color:T.gT,cursor:'pointer',fontWeight:600,textDecoration:'underline dotted'}}>{num}</span>);
                last=m.index+num.length;
              }
              if(last<text.length)parts.push(text.slice(last));
              return parts;
            }
            return(
              <div style={{flex:1,overflow:'auto',padding:'16px 18px 32px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontFamily:FS,fontSize:13,letterSpacing:'0.12em',color:T.gT,fontWeight:600}}>{te.strongs_number}</span>
                    {totalCount>0&&<span style={{fontFamily:FB,fontSize:12,color:T.dim,background:T.bgCH,borderRadius:10,padding:'2px 7px'}}>×{totalCount}</span>}
                  </div>
                  <button onClick={()=>{setStrongsTabEntry(null);}} style={{background:'none',border:'none',color:T.dim,cursor:'pointer',fontSize:18}}>✕</button>
                </div>
                {!e?(
                  <div style={{textAlign:'center',padding:20,color:T.dim,fontFamily:FB}}>Loading…</div>
                ):(
                  <>
                    <div style={{fontSize:Math.max(24,Math.round(readFontSize*1.1)),color:T.body,marginBottom:4,fontFamily:fontFamilyMap[readFontFamily]}}>{e.original_word}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,marginBottom:2}}>{e.transliteration}{e.pronunciation?` (${e.pronunciation})`:''}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim,marginBottom:12,fontStyle:'italic'}}>{e.language==='hebrew'?'Hebrew':'Greek'}</div>
                    <div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,lineHeight:readLineHeight,marginBottom:12}}>{e.short_def}</div>
                    {e.full_def&&<div style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.88),color:T.mut,lineHeight:readLineHeight,marginBottom:12}}>{renderDerivation(e.full_def)}</div>}
                    {groupList.length>0&&(
                      <div style={{borderTop:`1px solid ${T.bd}`,paddingTop:10,marginTop:4}}>
                        <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.12em',color:T.gM,marginBottom:4}}>KJV USAGE</div>
                        <div style={{fontFamily:FS,fontSize:10,letterSpacing:'0.08em',color:T.dim,marginBottom:8}}>Total KJV Occurrences (×{totalCount})</div>
                        {groupList.map(([key,{word,refs}])=>{
                          const isExpanded=strongsExpandedWords.has(key);
                          const refArr=[...refs.entries()].map(([r,cnt])=>{const[bn,ch,vs]=r.split('|').map(Number);return{bn,ch,vs,cnt};}).sort((a,b)=>a.bn-b.bn||a.ch-b.ch||a.vs-b.vs);
                          const bkName=bn=>BIBLE[bn-1]?.name||'';
                          return(
                            <div key={key} style={{marginBottom:8}}>
                              <div onClick={()=>setStrongsExpandedWords(s=>{const ns=new Set(s);ns.has(key)?ns.delete(key):ns.add(key);return ns;})}
                                style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',padding:'4px 0'}}>
                                <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:readFontSize,color:T.body,fontWeight:600}}>{word}</span>
                                <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.dim}}>(×{[...refs.values()].reduce((s,c)=>s+c,0)})</span>
                                <span style={{fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.76),color:T.dim,marginLeft:'auto'}}>{isExpanded?'▴':'▾'}</span>
                              </div>
                              {isExpanded&&(
                                <div style={{paddingLeft:8,paddingBottom:4}}>
                                  {refArr.map(({bn,ch,vs,cnt})=>(
                                    <span key={`${bn}-${ch}-${vs}`} onClick={()=>{setReadBook(bn);setReadCh(ch);readScrollToVerse.current=vs;setTab('read');}}
                                      style={{display:'inline-block',fontFamily:fontFamilyMap[readFontFamily],fontSize:Math.round(readFontSize*0.82),color:T.gT,cursor:'pointer',marginRight:10,marginBottom:4,textDecoration:'underline dotted'}}>
                                      {bkName(bn)} {ch}:{vs}{cnt>1?` ×${cnt}`:''}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {groupList.length===0&&te.versesLoading&&<div style={{fontFamily:FB,fontSize:13,color:T.dim,paddingTop:8}}>Loading verses…</div>}
                  </>
                )}
              </div>
            );
          })()}

          {/* Search results list */}
          {strongsSearchRes&&strongsSearchRes.length>0&&!strongsTabEntry&&(
            <div style={{flex:1,overflow:'auto',padding:'6px 0'}}>
              {strongsSearchRes.map(r=>(
                <div key={r.strongs_number} onClick={()=>{
                  const sn=r.strongs_number;
                  setStrongsTabEntry({strongs_number:sn,entry:null,verses:null,versesLoading:true});
                  setStrongsExpandedWords(new Set());
                  Promise.all([dbGetStrongsEntry(sn),dbGetStrongsVerses(sn)]).then(([entry,verses])=>{
                    setStrongsTabEntry(prev=>prev&&prev.strongs_number===sn?{strongs_number:sn,entry,verses,versesLoading:false}:prev);
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
      {modal?.type==='versions'&&<VersionsModal data={data} onSave={saveVersions} onClose={closeModal} onBack={()=>closeModal(()=>setReadMobileSheet('version'))} T={T} dlStates={dlStates} onDownload={startDownload} onDeleteLocal={deleteDownload} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='bookmarks'&&<BookmarksPanel T={T} bookmarks={bookmarks} categories={bmCategories} onDelete={handleDelBookmark} onOpen={openFromBookmark} onClose={closeModal} onUpdate={handleUpdateBookmark} onAddCat={handleAddCategory} onDeleteCat={handleDeleteCategory} onUpdateCat={handleUpdateCategory} versions={data.versions} user={user} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='recents'&&<RecentsPanel T={T} recents={recents} onOpen={openFromRecent} onClose={closeModal} versions={data.versions} navH={navH} isClosing={modalClosing}/>}
      {modal?.type==='stats'&&<StatsModal data={data} T={T} onClose={()=>setModal(null)}/>}
      {modal?.type==='reset'&&<ResetConfirmModal T={T} onConfirm={doReset} onCancel={()=>setModal(null)} entryCount={data.entries.length} sectionCount={data.sections.length}/>}
      {modal?.type==='help'&&(
        <Modal title="Help & Reference" onClose={closeModal} wide T={T} topSheet={navH} isClosing={modalClosing} footer={<><PBtn ch="⚠ Reset to Defaults" onClick={()=>setModal({type:'reset'})} T={T} danger sm/><SBtn ch="Close" onClick={closeModal} T={T}/></>}>
          {(()=>{
            const Hdg=({label})=>(
              <div style={{display:'flex',alignItems:'center',gap:10,margin:'22px 0 10px'}}>
                <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,whiteSpace:'nowrap'}}>{label}</div>
                <div style={{flex:1,height:1,background:T.bd}}/>
              </div>
            );
            const Row=({icon,children})=>(
              <div style={{display:'flex',gap:10,alignItems:'flex-start',marginBottom:9}}>
                <span style={{fontSize:15,flexShrink:0,width:22,textAlign:'center',marginTop:1}}>{icon}</span>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.7}}>{children}</span>
              </div>
            );
            const Chip=({children})=>(
              <span style={{display:'inline-flex',alignItems:'center',background:T.bgSec,border:`1px solid ${T.bd}`,borderRadius:5,padding:'2px 7px',fontFamily:'monospace',fontSize:12,color:T.gT,marginRight:6,marginBottom:4}}>{children}</span>
            );
            return(
              <div>
                {/* ── READING ── */}
                <Hdg label="Reading"/>
                <Row icon="✦">
                  <strong style={{color:T.gT}}>Navigate</strong> with the bottom bar — tap the <strong style={{color:T.gT}}>book icon</strong> to jump to any book and chapter, or tap the <strong style={{color:T.gT}}>version label</strong> (e.g. KJV) to switch translations.
                </Row>
                <Row icon="👆">
                  <strong style={{color:T.gT}}>Tap any verse</strong> to select it (it highlights). Tap again to deselect. You can select multiple verses at once.
                </Row>
                <Row icon="⛶">
                  <strong style={{color:T.gT}}>Fullscreen mode</strong> hides the navigation bar when you scroll down for distraction-free reading. Enable it in <em>Settings → Fullscreen</em>. Scroll back up to reveal the bar.
                </Row>
                <Row icon="🔴">
                  <strong style={{color:T.gT}}>Red Letter</strong> highlights words spoken by Jesus. Enable in <em>Settings → Reading Appearance → Red Letter</em>. Only available on versions with red-letter data.
                </Row>
                <Row icon="¶">
                  <strong style={{color:T.gT}}>Paragraph Mode</strong> flows verses into continuous paragraphs instead of numbered lines — useful for narrative reading.
                </Row>

                {/* ── SEARCH ── */}
                <Hdg label="Search"/>
                <Row icon="🔍">
                  Tap the <strong style={{color:T.gT}}>search icon</strong> in the bottom bar to search the current version. Results are grouped by book.
                </Row>
                <Row icon="≡">
                  A <strong style={{color:T.gT}}>book jump list</strong> appears on the right edge while scrolling through results — tap any abbreviation to jump straight to that book's results.
                </Row>
                <Row icon="←">
                  Tap <strong style={{color:T.gT}}>← Back to Reading</strong> (floating pill at the top) to dismiss results and return to where you were.
                </Row>

                {/* ── VERSE SELECTION & BOOKMARKS ── */}
                <Hdg label="Verse Selection & Bookmarks"/>
                <Row icon="⧉">
                  After selecting one or more verses a bar appears at the bottom. Tap <strong style={{color:T.gT}}>Copy</strong> to copy the verses with their reference formatted for sharing.
                </Row>
                <Row icon="✦">
                  Tap <strong style={{color:T.gT}}>Bookmark</strong> to save the selected passage. View all bookmarks in <em>Settings → Bookmarks</em>.
                </Row>
                <Row icon="▶">
                  If verses are selected when you press <strong style={{color:T.gT}}>Play</strong>, audio starts from the first selected verse instead of the chapter beginning.
                </Row>

                {/* ── AUDIO ── */}
                <Hdg label="Audio"/>
                <Row icon="▶">
                  Tap the <strong style={{color:T.gT}}>play button</strong> (bottom-right while in the Read tab) to start audio for the current chapter. The button expands to show the active verse number.
                </Row>
                <Row icon="🎙">
                  Audio uses <strong style={{color:T.gT}}>Faith Comes By Hearing (FCBH)</strong> streaming where available — professional narration matched to the text. Falls back to your device's built-in text-to-speech when FCBH isn't available for a version.
                </Row>
                <Row icon="⚙">
                  Change the audio source, voice, and playback speed in <em>Settings → Audio Settings</em>. Voice selection only applies when using text-to-speech.
                </Row>

                {/* ── STRONG'S NUMBERS ── */}
                <Hdg label="Strong's Numbers (KJV+ only)"/>
                <Row icon="ℍ">
                  Enable via the <strong style={{color:T.gT}}>Strong's toggle</strong> in Settings. Requires the <strong style={{color:T.gT}}>KJV+</strong> version to be selected.
                </Row>
                <Row icon="﹏">
                  Every word gets a <strong style={{color:T.gT}}>dotted underline</strong> linking it to its original Hebrew or Greek root. Words that share one root are grouped under a single continuous underline — e.g. "Let there be" is one phrase under one Hebrew word.
                </Row>
                <Row icon="👆">
                  <strong style={{color:T.gT}}>Double-tap</strong> any underlined word or phrase to open a popup showing the Strong's number, original word, transliteration, pronunciation, short definition, and full lexical entry.
                </Row>
                <Row icon="⬇">
                  Download the <strong style={{color:T.gT}}>Strong's Concordance</strong> offline (Settings → Offline Data) for instant lookups without an internet connection. 14,197 Hebrew & Greek entries, ~8 MB.
                </Row>

                {/* ── WEBSTER'S 1828 ── */}
                <Hdg label="Webster's 1828 Dictionary"/>
                <Row icon="W">
                  Access the full <strong style={{color:T.gT}}>Webster's 1828 American Dictionary</strong> from the Study tab. Search any English word for its historical definition — written in the same era as many classic translations.
                </Row>
                <Row icon="⬇">
                  Download Webster's offline (Settings → Offline Data) for 107,793 entries without internet. ~50 MB.
                </Row>

                {/* ── OFFLINE DATA ── */}
                <Hdg label="Offline Data"/>
                <Row icon="📖">
                  <strong style={{color:T.gT}}>Bible versions</strong> can be downloaded for offline use. Go to <em>Settings → Offline Data → Manage Bible Versions</em> and tap the download arrow next to any version.
                </Row>
                <Row icon="✓">
                  A version marked <strong style={{color:T.greenTxt||'#62c484'}}>✓ Offline</strong> is fully cached — it works with no internet. Tap the button again to remove the offline copy and free up space.
                </Row>

                {/* ── SETTINGS REFERENCE ── */}
                <Hdg label="Settings Reference"/>
                {[
                  ['Accent Color','Changes the highlight color throughout the entire app — underlines, active borders, selected verse glow, buttons.'],
                  ['Text Size','Adjust the reading font size from small to large.'],
                  ['Line Spacing','Controls how much vertical space appears between lines of text (Tight → Wide).'],
                  ['Font','Serif (Cormorant Garamond), Sans-Serif (Inter), or Monospace (JetBrains Mono).'],
                  ['Alignment','Left-aligned or fully justified text.'],
                  ['Verse Numbers','Superscript (small raised numbers), Inline (same size as text), or Hidden.'],
                  ['Paragraph Mode','Removes verse-by-verse line breaks and flows text as paragraphs.'],
                  ['Red Letter','Colors words of Jesus red (versions that support it only).'],
                  ['Strong\'s','Activates Hebrew/Greek root underlines on every word. KJV+ only.'],
                  ['Fullscreen','Auto-hides the navigation bar when scrolling down.'],
                ].map(([k,v])=>(
                  <div key={k} style={{display:'flex',gap:10,alignItems:'baseline',marginBottom:7}}>
                    <span style={{fontFamily:FS,fontSize:10,color:T.gT,letterSpacing:'0.06em',flexShrink:0,minWidth:100,fontWeight:600}}>{k}</span>
                    <span style={{fontFamily:FB,fontSize:13,color:T.dim,lineHeight:1.6}}>{v}</span>
                  </div>
                ))}

                {/* ── SHORTCUTS ── */}
                <Hdg label="Keyboard Shortcuts"/>
                <div style={{display:'flex',flexWrap:'wrap',gap:'6px 0',alignItems:'center',fontFamily:FB,fontSize:13,color:T.mut}}>
                  <Chip>Ctrl / ⌘ Z</Chip><span style={{marginRight:16}}>Undo last deleted item</span>
                  <Chip>Esc</Chip><span style={{marginRight:16}}>Close any panel or modal</span>
                  <Chip>Swipe down</Chip><span>Dismiss bottom sheets</span>
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
                <div style={{fontFamily:FS,fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:T.gM,fontWeight:700,whiteSpace:'nowrap'}}>{label}</div>
                <div style={{flex:1,height:1,background:T.bd}}/>
              </div>
            );
            const P=({children})=>(
              <p style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.75,marginBottom:10,marginTop:0}}>{children}</p>
            );
            const Li=({children})=>(
              <div style={{display:'flex',gap:8,alignItems:'flex-start',marginBottom:7}}>
                <span style={{color:T.gM,flexShrink:0,marginTop:3,fontSize:10}}>◆</span>
                <span style={{fontFamily:FB,fontSize:14,color:T.mut,lineHeight:1.7}}>{children}</span>
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

                {/* THIRD-PARTY VERSIONS */}
                <Hdg label="Third-Party Bible Versions"/>
                <Li><strong style={{color:T.gT}}>Reina-Valera Gómez (RVG)</strong> — © Dr. Humberto Gómez Caballero. Licensed under Creative Commons CC BY-NC-ND 3.0. Used for personal, non-commercial study only. For commercial or distribution licensing, contact the copyright holder directly.</Li>
                <Li><strong style={{color:T.gT}}>Purificada 1602 (1602P)</strong> — © 2007–2024 Iglesia Bautista Bíblica de la Gracia, Monterrey, Mexico. Textual restoration based on the 1602 Reina-Valera. Used for study and research purposes without modification.</Li>

                {/* AUDIO */}
                <Hdg label="Audio Attribution"/>
                <Li><strong style={{color:T.gT}}>Faith Comes By Hearing (FCBH)</strong> — Streaming audio provided by Faith Comes By Hearing (Hosanna/FCBH), Albuquerque, NM. Audio content is copyright © its respective rights holders and is streamed for personal, non-commercial listening only. Visit <span style={{color:T.gT}}>www.faithcomesbyhearing.com</span> for more information.</Li>
                <Li><strong style={{color:T.gT}}>Browser Text-to-Speech</strong> — Synthesized audio is generated by your device's built-in speech engine and is not derived from any recorded performance.</Li>

                {/* ATTRIBUTION */}
                <Hdg label="Attribution Requirements"/>
                <P>If you quote or share content produced with the aid of this app, please attribute the Bible version used (e.g., "KJV", "RVG") and verify the text against a printed edition. For copyrighted versions, follow the attribution guidelines set by each version's copyright holder.</P>

                {/* DISCLAIMER */}
                <Hdg label="Disclaimer of Warranties"/>
                <P>Scriptorium is provided "as is" without warranty of any kind, express or implied. While every effort is made to ensure textual accuracy, no guarantee is made that verse text, Strong's data, or dictionary entries are free from error. Users are responsible for verifying all content against authoritative printed sources.</P>
                <P>This app does not store, transmit, or sell personal study data beyond what is required for account sync. See our Privacy Policy for details.</P>

                {/* VERSION */}
                <div style={{marginTop:28,paddingTop:16,borderTop:`1px solid ${T.bdS}`,display:'flex',alignItems:'center',gap:12}}>
                  <div style={{flex:1,height:1,background:T.accentLine}}/>
                  <span style={{fontFamily:FS,fontSize:8,letterSpacing:'0.2em',color:T.gD,textTransform:'uppercase',fontWeight:500}}>To God Alone Be the Glory</span>
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
              <span style={{fontFamily:FS,fontSize:13,fontWeight:600,color:T.gT,letterSpacing:'0.1em',textTransform:'uppercase'}}>Custom Color</span>
              <button type="button" onClick={()=>{setAccent(pickerOrigRef.current.accent);setCustomAccentHex(pickerOrigRef.current.hex);setCustomPickerOpen(false);}}
                style={{background:'none',border:'none',color:T.dim,fontSize:18,cursor:'pointer',lineHeight:1,padding:4}}>✕</button>
            </div>

            {/* Color preview swatch */}
            <div style={{height:80,borderRadius:14,background:`linear-gradient(135deg,${hslToHex(pickerH,pickerS,Math.min(pickerL+15,95))},${hslToHex(pickerH,pickerS,pickerL)},${hslToHex(pickerH,pickerS,Math.max(pickerL-15,5))})`,marginBottom:18,boxShadow:`0 4px 20px ${hslToHex(pickerH,pickerS,pickerL)}66,inset 0 1px 0 rgba(255,255,255,0.15)`,display:'flex',alignItems:'flex-end',justifyContent:'flex-end',padding:'8px 10px'}}>
              <span style={{fontFamily:'monospace',fontSize:12,color:'rgba(255,255,255,0.85)',fontWeight:600,letterSpacing:'0.08em',textShadow:'0 1px 4px rgba(0,0,0,0.6)',background:'rgba(0,0,0,0.25)',borderRadius:6,padding:'3px 7px'}}>{hslToHex(pickerH,pickerS,pickerL).toUpperCase()}</span>
            </div>

            {/* Hue */}
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:12,color:T.mut}}>Hue</span>
                <span style={{fontFamily:'monospace',fontSize:11,color:T.gM}}>{pickerH}°</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="360" value={pickerH}
                onChange={e=>{const h=Number(e.target.value);setPickerH(h);const hex=hslToHex(h,pickerS,pickerL);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))`}}/>
            </div>

            {/* Saturation */}
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:12,color:T.mut}}>Saturation</span>
                <span style={{fontFamily:'monospace',fontSize:11,color:T.gM}}>{pickerS}%</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="100" value={pickerS}
                onChange={e=>{const s=Number(e.target.value);setPickerS(s);const hex=hslToHex(pickerH,s,pickerL);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(${pickerH},0%,${pickerL}%),hsl(${pickerH},100%,${pickerL}%))`}}/>
            </div>

            {/* Lightness */}
            <div style={{marginBottom:22}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontFamily:FB,fontSize:12,color:T.mut}}>Lightness</span>
                <span style={{fontFamily:'monospace',fontSize:11,color:T.gM}}>{pickerL}%</span>
              </div>
              <input type="range" className="cpicker-slider" min="0" max="100" value={pickerL}
                onChange={e=>{const l=Number(e.target.value);setPickerL(l);const hex=hslToHex(pickerH,pickerS,l);setCustomAccentHex(hex);}}
                style={{background:`linear-gradient(to right,hsl(${pickerH},${pickerS}%,0%),hsl(${pickerH},${pickerS}%,50%),hsl(${pickerH},${pickerS}%,100%))`}}/>
            </div>

            {/* Buttons */}
            <div style={{display:'flex',gap:8}}>
              <button type="button" onClick={()=>{setAccent(pickerOrigRef.current.accent);setCustomAccentHex(pickerOrigRef.current.hex);setCustomPickerOpen(false);}}
                style={{flex:1,background:'transparent',border:`1px solid ${T.bd}`,borderRadius:9,color:T.dim,fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'11px 0',cursor:'pointer'}}>
                Cancel
              </button>
              <button type="button" onClick={()=>setCustomPickerOpen(false)}
                style={{flex:2,background:T.gF,border:`1px solid ${T.gD}`,borderRadius:9,color:T.gT,fontFamily:FS,fontSize:10,letterSpacing:'0.08em',padding:'11px 0',cursor:'pointer',fontWeight:600}}>
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
