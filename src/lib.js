import React from 'react';

// ── Supabase config ───────────────────────────────────────
export const SUPA_URL = import.meta.env.VITE_SUPA_URL;
export const SUPA_ANON = import.meta.env.VITE_SUPA_ANON;

export const SB_KEY = `sb-garuwsjczcptykehgjdx-auth-token`;

export function sbHeaders(token) {
  return {
    "Content-Type": "application/json",
    "apikey": SUPA_ANON,
    "Authorization": `Bearer ${token || SUPA_ANON}`,
  };
}
export function getToken() {
  try { const s = JSON.parse(localStorage.getItem(SB_KEY)||'null'); return s?.access_token||null; } catch { return null; }
}
export function saveSession(s) {
  if (s) localStorage.setItem(SB_KEY, JSON.stringify(s));
  else localStorage.removeItem(SB_KEY);
}

// ── REST helpers ──────────────────────────────────────────
export async function sbFrom(table, token) {
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

export async function sbRpc(func, params, token) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${func}`, {
    method:'POST', headers: sbHeaders(token), body: JSON.stringify(params)
  });
  const d = await r.json();
  return { data: d, error: r.ok?null:d };
}

// ── Auth ──────────────────────────────────────────────────
export const authListeners = [];
export const Auth = {
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
export const IDB_NAME='scriptorium';
export const IDB_VER=2;
let _idbInst=null;

export function idbOpen(){
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
export function _idbReq(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});}

// ── Bible verses ──────────────────────────────────────────
export async function idbGetChapterLocal(versionId,bookNum,chapter){
  const db=await idbOpen();
  const rows=await _idbReq(db.transaction('verses','readonly').objectStore('verses').index('by_chapter').getAll([versionId,bookNum,chapter]));
  return rows.sort((a,b)=>a.verse-b.verse);
}
export async function idbPutVerses(versionId,rows){
  const db=await idbOpen();
  const tx=db.transaction('verses','readwrite');
  const st=tx.objectStore('verses');
  for(const r of rows)st.put({pk:`${versionId}|${r.book_num}|${r.chapter}|${r.verse}`,version_id:versionId,book_num:r.book_num,chapter:r.chapter,verse:r.verse,text:r.text});
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}

// ── Strong's lexicon ──────────────────────────────────────
export async function idbGetStrongsEntryLocal(num){
  const db=await idbOpen();
  return _idbReq(db.transaction('strongs_lex','readonly').objectStore('strongs_lex').get(num));
}
export async function idbSearchStrongsLocal(query){
  const db=await idbOpen();
  const all=await _idbReq(db.transaction('strongs_lex','readonly').objectStore('strongs_lex').getAll());
  const q=query.toLowerCase();
  // Match by strongs_number prefix OR word/def contains query
  return all.filter(e=>
    e.strongs_number.toLowerCase().startsWith(q)||
    (e.word_lower&&e.word_lower.includes(q))||
    (e.short_def&&e.short_def.toLowerCase().includes(q))
  ).slice(0,40);
}
export async function idbPutStrongsEntries(rows){
  const db=await idbOpen();
  const tx=db.transaction('strongs_lex','readwrite');
  const st=tx.objectStore('strongs_lex');
  for(const r of rows)st.put({...r,word_lower:(r.transliteration||r.short_def||'').toLowerCase()});
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}
export async function idbClearStrongs(){
  const db=await idbOpen();
  const tx=db.transaction('strongs_lex','readwrite');
  tx.objectStore('strongs_lex').clear();
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}

// ── Webster's 1828 ────────────────────────────────────────
export async function idbSearchWebsterLocal(query){
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
export async function idbPutWebsterEntries(rows){
  const db=await idbOpen();
  const tx=db.transaction('webster','readwrite');
  const st=tx.objectStore('webster');
  for(const r of rows)st.add({...r,word_lower:(r.word||'').toLowerCase()});
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}
export async function idbClearWebster(){
  const db=await idbOpen();
  const tx=db.transaction('webster','readwrite');
  tx.objectStore('webster').clear();
  return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});
}

// ── Meta / download flags ─────────────────────────────────
export async function idbGetMeta(key){try{const db=await idbOpen();const r=await _idbReq(db.transaction('meta','readonly').objectStore('meta').get(key));return r?.value;}catch{return undefined;}}
export async function idbPutMeta(key,value){const db=await idbOpen();const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({key,value});return new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);});}
export async function idbIsDownloaded(id){return(await idbGetMeta(`dl:${id}`))===true;}

// ── Bible version delete ──────────────────────────────────
export async function idbDeleteVersionLocal(versionId){
  const db=await idbOpen();
  const tx=db.transaction('verses','readwrite');
  const idx=tx.objectStore('verses').index('by_chapter');
  const range=IDBKeyRange.bound([versionId,0,0],[versionId,999,9999]);
  await new Promise((res,rej)=>{
    const req=idx.openCursor(range);
    req.onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}};
    tx.oncomplete=res;tx.onerror=e=>rej(e.target.error);
  });
  await idbPutMeta(`dl:${versionId}`,false);
}

// ── Generic batch downloader ──────────────────────────────
export async function _batchDownload({table,select,filter,order,putFn,dlKey,total:initTotal,onProgress,signal}){
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

export async function downloadVersionLocally(versionId,onProgress,signal){
  await _batchDownload({table:'bible_verses',select:'book_num,chapter,verse,text',filter:`version_id=eq.${encodeURIComponent(versionId)}`,order:'book_num.asc,chapter.asc,verse.asc',putFn:rows=>idbPutVerses(versionId,rows),dlKey:versionId,total:31102,onProgress,signal});
}
export async function downloadStrongsLocally(onProgress,signal){
  await idbClearStrongs();
  await _batchDownload({table:'strongs_lexicon',select:'strongs_number,original_word,transliteration,pronunciation,language,short_def,full_def,kjv_usage',order:'strongs_number.asc',putFn:idbPutStrongsEntries,dlKey:'strongs',total:14197,onProgress,signal});
}
export async function downloadWebsterLocally(onProgress,signal){
  await idbClearWebster();
  await _batchDownload({table:'webster_1828',select:'word,pos,definitions',order:'word.asc',putFn:idbPutWebsterEntries,dlKey:'webster',total:107793,onProgress,signal});
}


// ══════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════
export const BIBLE = [
  {n:1,name:'Genesis',v:[31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26]},
  {n:2,name:'Exodus',v:[22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,16,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38]},
  {n:3,name:'Leviticus',v:[17,16,17,35,19,30,38,36,24,20,47,8,59,57,33,34,16,30,37,27,24,33,44,23,55,46,34]},
  {n:4,name:'Numbers',v:[54,34,51,49,31,27,89,26,23,36,35,16,33,45,41,50,13,32,22,29,35,41,30,25,18,65,23,31,40,16,54,42,56,29,34,13]},
  {n:5,name:'Deuteronomy',v:[46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,29,20,30,52,29,12]},
  {n:6,name:'Joshua',v:[18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33]},
  {n:7,name:'Judges',v:[36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25]},
  {n:8,name:'Ruth',v:[22,23,18,22]},
  {n:9,name:'1 Samuel',v:[28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13]},
  {n:10,name:'2 Samuel',v:[27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25]},
  {n:11,name:'1 Kings',v:[53,46,28,34,18,38,51,66,28,29,43,33,34,31,34,34,24,46,21,43,29,53]},
  {n:12,name:'2 Kings',v:[18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,41,37,37,21,26,20,37,20,30]},
  {n:13,name:'1 Chronicles',v:[54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30]},
  {n:14,name:'2 Chronicles',v:[17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23]},
  {n:15,name:'Ezra',v:[11,70,13,24,17,22,28,36,15,44]},
  {n:16,name:'Nehemiah',v:[11,20,32,23,19,19,73,18,38,39,36,47,31]},
  {n:17,name:'Esther',v:[22,23,15,17,14,14,10,17,32,3]},
  {n:18,name:'Job',v:[22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,28,25,31,40,22,33,37,16,33,24,41,30,24,34,17]},
  {n:19,name:'Psalms',v:[6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,8,8,3,18,3,3,21,26,9,8,24,13,10,10,7,12,15,21,10,20,14,9,6]},
  {n:20,name:'Proverbs',v:[33,22,35,27,23,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,29,35,34,28,28,27,28,27,33,31]},
  {n:21,name:'Ecclesiastes',v:[18,26,22,16,20,12,29,17,18,20,10,14]},
  {n:22,name:'Song of Solomon',v:[17,17,11,16,16,13,13,14]},
  {n:23,name:'Isaiah',v:[31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24]},
  {n:24,name:'Jeremiah',v:[19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34]},
  {n:25,name:'Lamentations',v:[22,22,66,22,22]},
  {n:26,name:'Ezekiel',v:[28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,14,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,15,38,28,23,29,49,26,20,27,31,25,24,23,35]},
  {n:27,name:'Daniel',v:[21,49,30,37,31,28,28,27,27,21,45,13]},
  {n:28,name:'Hosea',v:[11,23,5,19,15,11,16,14,17,15,12,14,16,9]},
  {n:29,name:'Joel',v:[20,32,21]},
  {n:30,name:'Amos',v:[15,16,15,13,27,14,17,14,15]},
  {n:31,name:'Obadiah',v:[21]},
  {n:32,name:'Jonah',v:[17,10,10,11]},
  {n:33,name:'Micah',v:[16,13,12,13,15,16,20]},
  {n:34,name:'Nahum',v:[15,13,19]},
  {n:35,name:'Habakkuk',v:[17,20,19]},
  {n:36,name:'Zephaniah',v:[18,15,20]},
  {n:37,name:'Haggai',v:[15,23]},
  {n:38,name:'Zechariah',v:[21,13,10,14,11,15,14,23,17,12,17,14,9,21]},
  {n:39,name:'Malachi',v:[14,17,18,6]},
  {n:40,name:'Matthew',v:[25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20]},
  {n:41,name:'Mark',v:[45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20]},
  {n:42,name:'Luke',v:[80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53]},
  {n:43,name:'John',v:[51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25]},
  {n:44,name:'Acts',v:[26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,40,38,40,30,35,27,27,32,44,31]},
  {n:45,name:'Romans',v:[32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27]},
  {n:46,name:'1 Corinthians',v:[31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24]},
  {n:47,name:'2 Corinthians',v:[24,17,18,18,21,18,16,24,15,18,33,21,14]},
  {n:48,name:'Galatians',v:[24,21,29,31,26,18]},
  {n:49,name:'Ephesians',v:[23,22,21,28,20,12]},
  {n:50,name:'Philippians',v:[30,30,21,23]},
  {n:51,name:'Colossians',v:[29,23,25,18]},
  {n:52,name:'1 Thessalonians',v:[10,20,13,18,28]},
  {n:53,name:'2 Thessalonians',v:[12,17,18]},
  {n:54,name:'1 Timothy',v:[20,15,16,16,25,21]},
  {n:55,name:'2 Timothy',v:[18,26,17,22]},
  {n:56,name:'Titus',v:[16,15,15]},
  {n:57,name:'Philemon',v:[25]},
  {n:58,name:'Hebrews',v:[14,18,19,16,14,20,28,13,28,39,40,29,25]},
  {n:59,name:'James',v:[27,26,18,17,20]},
  {n:60,name:'1 Peter',v:[25,25,22,19,14]},
  {n:61,name:'2 Peter',v:[21,22,18]},
  {n:62,name:'1 John',v:[10,29,24,21,21]},
  {n:63,name:'2 John',v:[13]},
  {n:64,name:'3 John',v:[14]},
  {n:65,name:'Jude',v:[25]},
  {n:66,name:'Revelation',v:[20,29,22,11,14,17,17,13,21,11,19,17,18,20,8,21,18,24,21,15,27,21]},
];
// ── Words of Jesus (Red Letter) — compact ranges per book:chapter ──
// Format: {bookNum:{chapter:"v1-v2,v3,v4-v5",...}}
export const WOJ_RAW={
40:{3:"15",4:"4,7,10,17,19",5:"3-48",6:"1-34",7:"1-27",8:"4,7,10-13,20,22,26,32",9:"2,4-6,9,12-13,15,22,24,28-30,37-38",10:"5-42",11:"4-6,7-11,14-15,17,20-30",12:"3-8,11-12,25-37,39-45,48-50",13:"11-17,18-23,24-30,31-33,37-43,44-52,57",14:"16,18,27,29,31",15:"3-11,13-14,16-20,24,26,28,32,34",16:"2-4,6,8-11,13,15,17-19,23-28",17:"7,9,11-12,17,20-21,22-23,25-27",18:"3-4,7-14,17-20,22-35",19:"4-6,8-12,14,17-21,23-24,26,28-30",20:"1-16,18-19,21-23,25-28,32",21:"2-3,13,16,19,21-22,24-27,28-31,33-44",22:"4-14,18-21,29-32,37-40,42-45",23:"2-39",24:"2,4-35,42-51",25:"1-13,14-30,31-46",26:"2,10-13,18,21,23-29,31-32,34,36,38,40-41,45-46,50,52-54,55-56,64",27:"11,46",28:"9-10,18-20"},
41:{1:"15,17,25,38,41,44",2:"5,8-11,14,17,19-22,24-28",3:"3-5,23-29,33-35",4:"3-9,11-12,13-20,21-25,26-29,30-32,35,39-40",5:"8-9,19,30,34,36,39,41",6:"4,10,31,37-38,50",7:"6-13,14-16,18-23,27,29,34",8:"1-2,5,12,15,17-21,29,33-38",9:"1,12-13,16,19,21,23,25,29,31,33,35-37,39-41,43-50",10:"3,5-9,11-12,14-15,18-21,23-27,29-31,33-34,36,38-40,42-45,47,49,51-52",11:"2-3,6,14,15-17,22-26,29-33",12:"6,9-11,15-17,24-27,29-31,35-37,38-40,43-44",13:"2,5-37",14:"6,13-15,18,20-25,27-28,30,32,34,36,38,41-42,48-49,62",15:"2,34",16:"15-18"},
42:{2:"49",4:"4,8,12,18-21,23-27,35,43",5:"4,10,12-13,20,22-24,27,31-32,33-39",6:"3-5,8-10,20-49",7:"9,13-14,22-28,31-35,40-48,50",8:"5-8,10-15,17-18,21-22,25,30,35,39,45-46,48,50,52,54",9:"3-5,12-14,18-20,22-27,35,41,44,48-50,54,57-62",10:"2-16,18-24,26,28,30-37,41-42",11:"2-13,17-26,28-36,39-52",12:"1-12,14-40,42-59",13:"2-5,7-9,12,15-16,18-21,23-30,32-35",14:"3,5,16-24,26-35",15:"3-7,8-10,11-32",16:"9,15,17,29-31",17:"1-4,6-10,14,17,19-37",18:"2-8,14,16-17,19-22,24-30,31-34,37,40-42",19:"5,9-10,12-27,30-31,40,42-44,46",20:"3-8,17-18,23-25,34-38,41-44,46",21:"3-4,5-36",22:"8-13,15-22,25-34,36-38,40,42,46,48,51,52-53,67-70",23:"3,28-31,34,43,46",24:"5,17,19,25-27,36,38-41,44-49"},
43:{1:"38-39,42-43,47,50-51",2:"4,7-8,16,19",3:"3,5-8,10-21",4:"7,10,13-14,16-18,21-24,26,32-35,38,48,50",5:"6,8,10-47",6:"5,10,12,20,26-65,67,70",7:"6-8,16-19,21-24,33-34,37-38",8:"7,10-12,14-18,19,21,23-26,28-29,31-38,39-47,49-51,54-56,58",9:"3-5,7,35,37,39,41",10:"1-18,25-30,32,34-38",11:"4,7,9-11,14-15,23,25-26,34,39-44",12:"7-8,23-28,30,32,35-36,44-50",13:"7-8,10-21,25-27,31-38",14:"1-31",15:"1-27",16:"1-33",17:"1-26",18:"4-5,7-9,11,20-21,23,34,36-37",19:"26-28,30",20:"15-17,19,21-23,26-27,29",21:"5-6,10,12,15-19,22-23"},
44:{1:"4-5,7-8",9:"4-6,10-12,15-16",10:"13,15",11:"7,9",18:"9-10",22:"7-8,10,18,21",23:"11",26:"14-18"},
66:{1:"8,11,17-20",2:"1-29",3:"1-22",16:"15",21:"5-8",22:"7,12-13,16,20"}
};
// Parse WOJ_RAW into a fast lookup Set
export const WOJ=new Set();
(function(){for(const[bk,chs]of Object.entries(WOJ_RAW)){for(const[ch,ranges]of Object.entries(chs)){ranges.split(',').forEach(r=>{const m=r.match(/^(\d+)-(\d+)$/);if(m){for(let v=+m[1];v<=+m[2];v++)WOJ.add(bk+':'+ch+':'+v);}else WOJ.add(bk+':'+ch+':'+r);});}}})();
export function isWOJ(bookNum,chapter,verse){return WOJ.has(bookNum+':'+chapter+':'+verse);}
export const ABBREVS={gen:'Genesis',ex:'Exodus',exo:'Exodus',lev:'Leviticus',num:'Numbers',deut:'Deuteronomy',dt:'Deuteronomy',josh:'Joshua',judg:'Judges',jdg:'Judges',ruth:'Ruth','1sam':'1 Samuel','2sam':'2 Samuel','1kgs':'1 Kings','1ki':'1 Kings','2kgs':'2 Kings','2ki':'2 Kings','1chr':'1 Chronicles','2chr':'2 Chronicles',ezr:'Ezra',neh:'Nehemiah',esth:'Esther',job:'Job',ps:'Psalms',psa:'Psalms',psalm:'Psalms',prov:'Proverbs',pr:'Proverbs',eccl:'Ecclesiastes',song:'Song of Solomon',sos:'Song of Solomon',isa:'Isaiah',jer:'Jeremiah',lam:'Lamentations',ezek:'Ezekiel',eze:'Ezekiel',dan:'Daniel',hos:'Hosea',joel:'Joel',amos:'Amos',obad:'Obadiah',jon:'Jonah',mic:'Micah',nah:'Nahum',hab:'Habakkuk',zeph:'Zephaniah',hag:'Haggai',zech:'Zechariah',mal:'Malachi',matt:'Matthew',mt:'Matthew',mk:'Mark',lk:'Luke',jn:'John',joh:'John',act:'Acts',rom:'Romans','1cor':'1 Corinthians','2cor':'2 Corinthians',gal:'Galatians',eph:'Ephesians',phil:'Philippians',php:'Philippians',col:'Colossians','1thess':'1 Thessalonians','2thess':'2 Thessalonians','1tim':'1 Timothy','2tim':'2 Timothy',tit:'Titus',phlm:'Philemon',heb:'Hebrews',jas:'James','1pet':'1 Peter','2pet':'2 Peter','1jn':'1 John','2jn':'2 John','3jn':'3 John',jude:'Jude',rev:'Revelation',apoc:'Revelation'};
export const ISSUE_TYPES=['manuscript','word','omission','article','grammar','doctrine','name','other'];
export const STATUS_VALUES=['reference','faithful','corrupt','diff','partial','missing'];
export const STATUS_LABELS={reference:'Reference',faithful:'Faithful',corrupt:'Corrupt / Alexandrian',diff:'Differs',partial:'Partial',missing:'Absent'};
export const ISSUE_LABELS={manuscript:'Manuscript',word:'Word Choice',omission:'Omission',article:'Article',grammar:'Grammar',doctrine:'Doctrine',name:'Name/Title',other:'Other'};
export const PUBLIC_VERSIONS=[{id:'kjv',label:'KJV',lang:'EN',isRef:true},{id:'rvg',label:'RVG',lang:'ES',isRef:false},{id:'p1602',label:'1602P',lang:'ES',isRef:false},{id:'rv1960',label:'RVR60',lang:'ES',isRef:false}];
// Webster's 1828 dictionary: 107,793 entries in Supabase table webster_1828
// Queried via RPC: search_webster_1828(query_term)

// ══════════════════════════════════════════════════════════
//  THEME
// ══════════════════════════════════════════════════════════
export const D={bg:'#0e0d0b',bg2:'#141311',bgCard:'#191815',bgCH:'#1f1e1a',bgSec:'#151412',bgIn:'#0e0d0b',bd:'#28251e',bdA:'#38332a',bdS:'#1e1c16',g:'#c8a84e',gT:'#e4cc78',gM:'#8a7a48',gD:'#4a3e22',gF:'#1e1a0e',body:'#ede4cf',mut:'#bfb090',dim:'#6a5e46',blue:'#0c1e32',blueTxt:'#7aaed8',green:'#0a2414',greenTxt:'#62c484',dif:'#0c2218',difTxt:'#7ab888',red:'#2a0c0c',redTxt:'#d46868',amb:'#241a06',ambTxt:'#cc9a38',pur:'#14082a',purTxt:'#9468c0',ora:'#221208',oraTxt:'#c87828',accentLine:'linear-gradient(90deg, transparent, #4a3e22, #c8a84e, #4a3e22, transparent)'};
export const L={bg:'#f6f3ec',bg2:'#f0ece3',bgCard:'#faf8f4',bgCH:'#f0ece3',bgSec:'#ebe6db',bgIn:'#faf8f4',bd:'#d4ccba',bdA:'#c0b090',bdS:'#ddd6c6',g:'#8a6420',gT:'#4a3008',gM:'#7a6040',gD:'#c0a068',gF:'#f0e8d4',body:'#1a1208',mut:'#3a2e18',dim:'#6a5a40',blue:'#dceaf8',blueTxt:'#1a4a8a',green:'#d2ecde',greenTxt:'#186030',dif:'#d8ecda',difTxt:'#2a7038',red:'#f6d8d8',redTxt:'#920e0e',amb:'#f8eacc',ambTxt:'#835000',pur:'#ece0f5',purTxt:'#5a2080',ora:'#fae0c0',oraTxt:'#7a3800',accentLine:'linear-gradient(90deg, transparent, #c0a068, #8a6420, #c0a068, transparent)'};
export const BD={manuscript:{bg:'#260808',txt:'#c86060',bd:'#4a1212'},word:{bg:'#221806',txt:'#b88828',bd:'#483008'},omission:{bg:'#180820',txt:'#9060b8',bd:'#341460'},article:{bg:'#081a1a',txt:'#48b8b8',bd:'#164040'},grammar:{bg:'#081220',txt:'#58a0c0',bd:'#163050'},doctrine:{bg:'#201008',txt:'#b86828',bd:'#482408'},name:{bg:'#1c1608',txt:'#b8a848',bd:'#403808'},other:{bg:'#161310',txt:'#786248',bd:'#342a1c'}};
export const BL={manuscript:{bg:'#f5d5d5',txt:'#8a0e0e',bd:'#c03030'},word:{bg:'#f8e8c0',txt:'#7a4a00',bd:'#b87820'},omission:{bg:'#ecd8f5',txt:'#521880',bd:'#8858b8'},article:{bg:'#cceeee',txt:'#0a5a5a',bd:'#287878'},grammar:{bg:'#cce4f0',txt:'#0a3858',bd:'#285878'},doctrine:{bg:'#f5dcc8',txt:'#702800',bd:'#b85818'},name:{bg:'#eeeac0',txt:'#524800',bd:'#888000'},other:{bg:'#e8e2d8',txt:'#524838',bd:'#908070'}};
export function stSt(s,T){switch(s){case'reference':return{bg:T.blue,txt:T.blueTxt};case'faithful':return{bg:T.green,txt:T.greenTxt};case'corrupt':return{bg:T.red,txt:T.redTxt};case'diff':return{bg:T.dif,txt:T.difTxt};case'partial':return{bg:T.ora,txt:T.oraTxt};case'missing':return{bg:T.pur,txt:T.purTxt};default:return{bg:T.bgCard,txt:T.dim};}}
export const ACCENTS={
  gold:      {dark:{g:'#c8a84e',gT:'#e4cc78',gM:'#8a7a48',gD:'#4a3e22',gF:'#1e1a0e'},light:{g:'#8a6420',gT:'#4a3008',gM:'#7a6040',gD:'#c0a068',gF:'#f0e8d4'}},
  slate:     {dark:{g:'#707070',gT:'#d0d0d0',gM:'#4e4e4e',gD:'#252525',gF:'#0e0e0e',body:'#e2e2e2',mut:'#a4a4a4',dim:'#5a5a5a'},light:{g:'#525252',gT:'#2a2a2a',gM:'#585858',gD:'#909090',gF:'#e8e8e8',body:'#161616',mut:'#3e3e3e',dim:'#606060'}},
  terracotta:{dark:{g:'#80665e',gT:'#d4a898',gM:'#594842',gD:'#2f231f',gF:'#110c0b',body:'#e1dddb',mut:'#a29a96',dim:'#59524f'},light:{g:'#54372f',gT:'#2a1b13',gM:'#4f3c34',gD:'#8e766e',gF:'#ece7e4',body:'#1c1614',mut:'#3e3430',dim:'#605650'}},
  steel:     {dark:{g:'#535f67',gT:'#a8bac8',gM:'#3c444a',gD:'#1c2024',gF:'#0a0c0e',body:'#dde0e3',mut:'#9fa4a9',dim:'#565c61'},light:{g:'#2a343e',gT:'#151c22',gM:'#37414c',gD:'#76818d',gF:'#e1e6eb',body:'#121618',mut:'#303840',dim:'#4c5460'}},
  sage:      {dark:{g:'#5f6c54',gT:'#aac09a',gM:'#414b39',gD:'#1f241c',gF:'#0b0d0a',body:'#dbded9',mut:'#989f95',dim:'#51554f'},light:{g:'#35402b',gT:'#1b2216',gM:'#3f4c35',gD:'#6c7d60',gF:'#dfe6da',body:'#121a10',mut:'#303c2c',dim:'#485440'}},
  heather:   {dark:{g:'#6f6878',gT:'#c0b8d0',gM:'#4d4853',gD:'#25222b',gF:'#0f0e12',body:'#dddbda',mut:'#9e9ca4',dim:'#57555c'},light:{g:'#443b53',gT:'#241f2f',gM:'#4e4457',gD:'#837b93',gF:'#ebe8ef',body:'#141218',mut:'#363040',dim:'#544e60'}},
  rose:      {dark:{g:'#7e6a72',gT:'#d0aab4',gM:'#56474d',gD:'#292023',gF:'#0e0a0c',body:'#e0dcdc',mut:'#a2979a',dim:'#564f51'},light:{g:'#4e2f3b',gT:'#28171f',gM:'#4f3942',gD:'#8b737b',gF:'#ede6e9',body:'#1c1416',mut:'#3c2c30',dim:'#5c4c50'}},
  sienna:    {dark:{g:'#726256',gT:'#c8aa90',gM:'#4e423a',gD:'#27211d',gF:'#0e0c0a',body:'#dddad7',mut:'#9f9995',dim:'#55514e'},light:{g:'#402f25',gT:'#201710',gM:'#463a32',gD:'#83736b',gF:'#ece8e3',body:'#1a1612',mut:'#3c342c',dim:'#5c5248'}},
};
export const FS="'Cinzel',Georgia,serif";
export const FB="'Cormorant Garamond','EB Garamond',Georgia,serif";
export const fontFamilyMap={serif:FB,sans:"'Inter','Segoe UI',system-ui,sans-serif",mono:"'JetBrains Mono','Fira Code','Courier New',monospace"};




// ══════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════
export const genId=()=>'id-'+Math.random().toString(36).slice(2,9)+Date.now().toString(36);
export const clone=d=>JSON.parse(JSON.stringify(d));
export const fmtDate=iso=>iso?new Date(iso).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'';
export const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function normRef(raw){if(!raw)return raw;const m=raw.trim().match(/^([\d]*\s*[a-zA-Z]+\.?)\s+(\d+.*)/);if(!m)return raw.trim();let book=m[1].replace(/\./g,'').trim();const key=book.toLowerCase().replace(/\s+/g,'');if(ABBREVS[key])book=ABBREVS[key];else book=book.charAt(0).toUpperCase()+book.slice(1);return book+' '+m[2];}
export function parseRef(ref){if(!ref)return null;const m=ref.match(/^(.+?)\s+(\d+):(.+)$/);return m?{book:m[1].trim(),chapter:m[2],verse:m[3].trim()}:null;}
export function parseRefDD(ref){if(!ref)return null;const m=ref.match(/^(.+?)\s+(\d+):(\d+)/);if(!m)return null;const b=BIBLE.find(x=>x.name.toLowerCase()===m[1].trim().toLowerCase());return b?{bookNum:b.n,chapter:parseInt(m[2]),verse:parseInt(m[3])}:null;}
export function hl(text,q,opts){if(!text)return'';const plain=text.replace(/<[^>]+>/g,'');if(!q)return esc(plain);const cs=opts&&opts.caseSensitive;const words=(opts&&opts.mode&&opts.mode!=='phrase')?q.split(/\s+/).filter(Boolean):[q];let out=esc(plain);words.forEach(w=>{const pat=w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const bounded=(opts&&opts.partial===false)?`\\b${pat}\\b`:pat;const rx=new RegExp(`(${bounded})`,cs?'g':'gi');out=out.replace(rx,'<mark class="sch">$1</mark>');});return out;}
export function processRedLetter(text,enabled,isDark){if(!text)return'';if(enabled){const c=isDark?'#ef5350':'#c62828';return text.replace(/<red>/g,`<span style="color:${c}">`).replace(/<\/red>/g,'</span>');}return text.replace(/<red>|<\/red>/g,'');}

export function buildStrongsVerse(text,mappings,onTap,T,dark,redLetter){
  // Build set of red-letter word positions and italic word positions by walking raw text
  const redSet=new Set();
  const italicSet=new Set();
  let inRed=false,inItalic=false,rIdx=0;
  const rawTokens=text.split(/(\s+|<red>|<\/red>|<i>|<\/i>|<[^>]+>)/);
  for(const tok of rawTokens){
    if(tok==='<red>'){inRed=true;}
    else if(tok==='</red>'){inRed=false;}
    else if(tok==='<i>'){inItalic=true;}
    else if(tok==='</i>'){inItalic=false;}
    else if(/^</.test(tok)||/^\s*$/.test(tok)){/* skip other tags and whitespace */}
    else{const wt=tok.replace(/^[.,;:!?'"()]+|[.,;:!?'"()]+$/g,'');if(wt){if(inRed)redSet.add(rIdx);if(inItalic)italicSet.add(rIdx);rIdx++;}}
  }
  const redColor=dark?'#ef5350':'#c62828';

  // mappings: [{word_pos, word_text, strongs_num}] for this verse
  const cleanText=text.replace(/<red>|<\/red>/g,'').replace(/<[^>]+>/g,'');
  if(!mappings||!mappings.length)return React.createElement('span',null,cleanText);
  const words=cleanText.split(/(\s+)/);
  // Build a lookup: word_pos -> [{strongs_num, word_text}]
  const posMap={};
  for(const m of mappings){
    if(!posMap[m.word_pos])posMap[m.word_pos]=[];
    posMap[m.word_pos].push(m);
  }
  const elems=[];
  let wordIdx=0;
  for(let i=0;i<words.length;i++){
    const w=words[i];
    if(/^\s+$/.test(w)){elems.push(w);continue;}
    const wordText=w.replace(/^[.,;:!?'"()]+|[.,;:!?'"()]+$/g,'');
    if(!wordText){elems.push(w);continue;}
    const isRed=redLetter&&redSet.has(wordIdx);
    const isItalic=italicSet.has(wordIdx);
    const isContextRed=redLetter&&isItalic&&!isRed&&(redSet.has(wordIdx-1)||redSet.has(wordIdx+1));
    const effectiveColor=isRed||isContextRed?redColor:undefined;
    const mapped=posMap[wordIdx];
    const wordStyle={...(effectiveColor?{color:effectiveColor}:{}),...(isItalic?{fontStyle:'italic'}:{})};
    if(mapped&&mapped.length>0){
      // Prefer the mapping whose word_text matches the actual displayed word
      const wordLower=wordText.toLowerCase();
      const bestMatch=mapped.find(m=>m.word_text&&m.word_text.toLowerCase()===wordLower);
      const sNum=bestMatch?bestMatch.strongs_num:mapped[0].strongs_num;
      elems.push(React.createElement('span',{
        key:i,
        onDoubleClick:e=>{e.stopPropagation();onTap(sNum,w);},
        style:{borderBottom:`1.5px dotted ${T.gM}`,cursor:'pointer',paddingBottom:1,...wordStyle}
      },w));
    }else{
      elems.push((effectiveColor||isItalic)?React.createElement('span',{key:i,style:wordStyle},w):w);
    }
    wordIdx++;
  }
  return React.createElement('span',null,...elems);
}

export function parseCSVtoRows(content){
  const rows=[];const lines=content.split(/\r?\n/);
  let start=0;
  if(lines[0]){const fc=lines[0].split(',')[0].replace(/"/g,'').trim().toLowerCase();if(fc==='book'||fc==='libro'||isNaN(parseInt(fc)))start=1;}
  for(let i=start;i<lines.length;i++){
    const line=lines[i].trim();if(!line)continue;
    const cols=[];let cur='',inQ=false;
    for(let j=0;j<line.length;j++){const c=line[j];if(c==='"'){if(inQ&&line[j+1]==='"'){cur+='"';j++;}else inQ=!inQ;}else if(c===','&&!inQ){cols.push(cur);cur='';}else cur+=c;}
    cols.push(cur);
    if(cols.length>=4){const bn=parseInt(cols[0]);if(!isNaN(bn)&&bn>=1&&bn<=66){const ch=parseInt(cols[1]);const vs=parseInt(cols[2]);const text=cols[3].replace(/^"|"$/g,'').replace(/""/g,'"').trim();if(ch&&vs&&text)rows.push({book_num:bn,chapter:ch,verse:vs,text});}}
  }
  return rows;
}

// ══════════════════════════════════════════════════════════
//  SUPABASE DB OPERATIONS
// ══════════════════════════════════════════════════════════
export async function dbGetChapter(versionId,bookNum,chapter){
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
export async function dbGetStrongsForChapter(bookNum,chapter){
  const token=getToken();
  const {data}=await sbRpc('get_strongs_for_chapter',{p_book_num:bookNum,p_chapter:chapter},token);
  return Array.isArray(data)?data:[];
}
export async function dbGetStrongsEntry(strongsNumber){
  try{if(await idbIsDownloaded('strongs')){const local=await idbGetStrongsEntryLocal(strongsNumber);if(local)return local;}}catch{}
  const token=getToken();
  const {data}=await sbRpc('get_strongs_entry',{p_strongs_number:strongsNumber},token);
  return data?.[0]||null;
}
export async function dbSearchStrongs(query){
  try{if(await idbIsDownloaded('strongs')){return await idbSearchStrongsLocal(query);}}catch{}
  const token=getToken();
  const {data}=await sbRpc('search_strongs',{p_query:query},token);
  return Array.isArray(data)?data:[];
}
export async function dbGetStrongsVerses(strongsNum){
  const token=getToken();
  const {data}=await sbRpc('get_strongs_verses',{p_strongs_num:strongsNum},token);
  return Array.isArray(data)?data:[];
}
export async function dbGetVerse(versionId,bookNum,chapter,verse){
  const token=getToken();
  const t=await sbFrom('bible_verses',token);
  const r=await t.select('verse,text',{version_id:versionId,book_num:bookNum,chapter,verse},{limit:1});
  return r.data?.[0]||null;
}
export async function dbAutoFill(bookNum,chapter,verse,versionIds){
  const results={};
  await Promise.all(versionIds.map(async vid=>{
    const row=await dbGetVerse(vid,bookNum,chapter,verse);
    if(row?.text)results[vid]=row.text;
  }));
  return results;
}
export async function dbLoadOrCreateProject(userId){
  const token=getToken();
  const t=await sbFrom('projects',token);
  const r=await t.select('*',{user_id:userId},{order:'created_at.asc',limit:1});
  if(r.data?.length)return r.data[0];
  const ins=await t.insert({user_id:userId,title:'My Study'});
  return ins.data?.[0]||null;
}
export async function dbLoadProject(projectId){
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
    versions:[...pvData,...extraVers].map(v=>({id:v.version_id,label:v.label,lang:v.lang,isRef:v.is_ref})),
  };
}
export async function dbSaveEntry(entry,projectId){
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
export async function dbDeleteEntry(id){const token=getToken();const t=await sbFrom('entries',token);await t.delete({id});}
export async function dbSaveSection(sec,projectId){
  const token=getToken();const t=await sbFrom('sections',token);
  if(sec._isNew||!sec.id){const r=await t.insert({project_id:projectId,title:sec.title,description:sec.description||null,position:sec.position||0});return r.data?.[0]?.id;}
  else{await t.update({title:sec.title,description:sec.description||null},{id:sec.id});return sec.id;}
}
export async function dbDeleteSection(id){const token=getToken();const t=await sbFrom('sections',token);await t.delete({id});}
export async function dbSaveVersions(projectId,versions){
  const token=getToken();const t=await sbFrom('project_versions',token);
  await t.delete({project_id:projectId});
  if(versions.length){const t2=await sbFrom('project_versions',token);await t2.insert(versions.map((v,i)=>({project_id:projectId,version_id:v.id,label:v.label,lang:v.lang||'EN',is_ref:!!v.isRef,position:i})));}
}
export async function dbLoadBookmarks(userId){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.select('*',{user_id:userId},{order:'created_at.desc'});return r.data||[];}
export async function dbAddBookmark(userId,{versionId,bookNum,chapter,verse,label}){const token=getToken();const t=await sbFrom('bookmarks',token);const r=await t.insert({user_id:userId,version_id:versionId,book_num:bookNum,chapter,verse:verse||null,label:label||null});return r.data?.[0];}
export async function dbDeleteBookmark(id){const token=getToken();const t=await sbFrom('bookmarks',token);await t.delete({id});}
export async function dbLoadRecents(userId){const token=getToken();const t=await sbFrom('recent_passages',token);const r=await t.select('*',{user_id:userId},{order:'visited_at.desc',limit:20});return r.data||[];}
export async function dbRecordRecent(userId,versionId,bookNum,chapter){const token=getToken();await sbRpc('upsert_recent_passage',{p_user_id:userId,p_version_id:versionId,p_book_num:bookNum,p_chapter:chapter},token);}
