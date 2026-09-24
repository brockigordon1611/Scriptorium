// Commentary modules, turned into the one small markup the Commentaries page
// draws. Shared by the app, when a reader imports a .cmti, and by
// scripts/export-tsk.mjs, which builds the bundled Treasury of Scripture
// Knowledge -- so an imported commentary and the built-in one come out in
// exactly the same shape.
//
// The markup, for each verse, chapter or book note:
//   one line per paragraph, separated by \n
//   <b>...</b> and <i>...</i>, opened and closed within a line
//   {b.c.v}  a reference; {b.c.v-v2} a range; {b.c.v-c2.v2} a range across chapters
//   &lt; &gt; &amp;  the only entities left, for a literal < > &
// Everything else in e-Sword's HTML -- styles, colours, links, tables -- goes,
// keeping its text. e-Sword stores all of it inline on every paragraph, which
// is most of why the TSK is 78 MB as a module and 14 MB here.

// e-Sword's book codes in canon order, as the TSK writes them.
export const ESWORD_BOOKS=['Gen','Exo','Lev','Num','Deu','Jos','Jdg','Rth','1Sa','2Sa','1Ki','2Ki','1Ch','2Ch','Ezr','Neh','Est','Job','Psa','Pro','Ecc','Son','Isa','Jer','Lam','Eze','Dan','Hos','Joe','Amo','Oba','Jon','Mic','Nah','Hab','Zep','Hag','Zec','Mal','Mat','Mar','Luk','Joh','Act','Rom','1Co','2Co','Gal','Eph','Php','Col','1Th','2Th','1Ti','2Ti','Tit','Phm','Heb','Jas','1Pe','2Pe','1Jn','2Jn','3Jn','Jud','Rev'];
const BOOK_NAMES=['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'];
const bookKey=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
// Other modules abbreviate differently. Their codes, then the common short
// forms whose prefix would be ambiguous or wrong (Jud is Jude to e-Sword, not
// Judges; Php and Phm are no prefix of anything).
const BOOK_ALIASES={rut:8,sos:22,sng:22,sol:22,song:22,songofsongs:22,canticles:22,psalm:19,ps:19,prv:20,qoh:21,ezk:26,jol:29,nam:34,mt:40,mk:41,mrk:41,lk:42,jn:43,jhn:43,phi:50,phil:50,phlm:57,philem:57,jude:65,jdgs:7,judg:7,jg:7};
const BOOKS_BY_KEY=new Map();
ESWORD_BOOKS.forEach((c,i)=>BOOKS_BY_KEY.set(bookKey(c),i+1));
BOOK_NAMES.forEach((n,i)=>BOOKS_BY_KEY.set(bookKey(n),i+1));
for(const[k,n]of Object.entries(BOOK_ALIASES))BOOKS_BY_KEY.set(k,n);
export function bookNumber(token){
  const k=bookKey(token);
  if(!k)return 0;
  if(BOOKS_BY_KEY.has(k))return BOOKS_BY_KEY.get(k);
  // Any unambiguous prefix of a full name: "Deut", "Matt", "1Thess".
  if(k.length<3)return 0;
  const hits=BOOK_NAMES.map((n,i)=>[bookKey(n),i+1]).filter(([n])=>n.startsWith(k));
  return hits.length===1?hits[0][1]:0;
}

// A reference as a module writes it -- "Pro 8:22-24", "1Sa 2:9", "Gen 2:4-3:1"
// -- to its token. Anything after the numbers ("2Ki 3:1, 2" is in the TSK) is
// handed back as text so nothing is lost.
export function refToken(text){
  const m=String(text||'').match(/^\s*((?:[1-3]\s?)?[A-Za-z]+\.?)\s*(\d+)\s*[:.]\s*(\d+)(?:\s*[-–]\s*(\d+)(?:\s*[:.]\s*(\d+))?)?(.*)$/s);
  if(!m)return null;
  const b=bookNumber(m[1]);
  if(!b)return null;
  const c=+m[2],v=+m[3];
  let tail='';
  if(m[5])tail=`-${+m[4]}.${+m[5]}`;
  else if(m[4]&&+m[4]>v)tail=`-${+m[4]}`;
  return{token:`{${b}.${c}.${v}${tail}}`,rest:m[6]||''};
}

// Named entities these modules use. A module with one not listed keeps it as
// written; the app passes a decoder that knows the rest.
const NAMED={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',sbquo:'‚',bdquo:'„',ndash:'–',mdash:'—',hellip:'…',middot:'·',bull:'•',para:'¶',sect:'§',pound:'£',copy:'©',reg:'®',deg:'°',dagger:'†',Dagger:'‡',laquo:'«',raquo:'»',times:'×',divide:'÷',frac12:'½',frac14:'¼',frac34:'¾',prime:'′',Prime:'″',
  aelig:'æ',AElig:'Æ',oelig:'œ',OElig:'Œ',szlig:'ß',ccedil:'ç',Ccedil:'Ç',ntilde:'ñ',Ntilde:'Ñ',atilde:'ã',Atilde:'Ã',otilde:'õ',
  aacute:'á',eacute:'é',iacute:'í',oacute:'ó',uacute:'ú',Aacute:'Á',Eacute:'É',Iacute:'Í',Oacute:'Ó',Uacute:'Ú',
  agrave:'à',egrave:'è',igrave:'ì',ograve:'ò',ugrave:'ù',acirc:'â',ecirc:'ê',icirc:'î',ocirc:'ô',ucirc:'û',
  auml:'ä',euml:'ë',iuml:'ï',ouml:'ö',uuml:'ü',Auml:'Ä',Ouml:'Ö',Uuml:'Ü',
  Alpha:'Α',Beta:'Β',Gamma:'Γ',Delta:'Δ',Epsilon:'Ε',Zeta:'Ζ',Eta:'Η',Theta:'Θ',Iota:'Ι',Kappa:'Κ',Lambda:'Λ',Mu:'Μ',Nu:'Ν',Xi:'Ξ',Omicron:'Ο',Pi:'Π',Rho:'Ρ',Sigma:'Σ',Tau:'Τ',Upsilon:'Υ',Phi:'Φ',Chi:'Χ',Psi:'Ψ',Omega:'Ω',
  alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',omicron:'ο',pi:'π',rho:'ρ',sigmaf:'ς',sigma:'σ',tau:'τ',upsilon:'υ',phi:'φ',chi:'χ',psi:'ψ',omega:'ω',thetasym:'ϑ',upsih:'ϒ',piv:'ϖ'};
export function decodeEntities(s,decodeNamed){
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,(all,e)=>{
    if(e[0]==='#'){const n=e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>0&&n<0x110000?String.fromCodePoint(n):all;}
    if(Object.prototype.hasOwnProperty.call(NAMED,e))return NAMED[e];
    return decodeNamed?decodeNamed(all):all;
  });
}
const escapeText=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Older e-Sword commentaries hold RTF rather than HTML. Enough of it is turned
// into HTML here -- paragraphs, bold, italic, escaped characters -- for the
// text to read; the rest of RTF's control words are dropped.
function rtfToHtml(s){
  return String(s)
    .replace(/\{\\\*[^{}]*\}/g,'')
    .replace(/\\(fonttbl|colortbl|stylesheet)[^{}]*(\{[^{}]*\}[^{}]*)*/g,'')
    .replace(/\\par[d]?\b ?/g,'</p><p>')
    .replace(/\\line\b ?/g,'<br>')
    .replace(/\\b0\b ?/g,'</b>').replace(/\\b\b ?/g,'<b>')
    .replace(/\\i0\b ?/g,'</i>').replace(/\\i\b ?/g,'<i>')
    .replace(/\\u(-?\d+)\??/g,(_,n)=>String.fromCharCode((+n+65536)%65536))
    .replace(/\\'([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))
    .replace(/\\([{}\\])/g,'$1')
    .replace(/\\[a-z]+-?\d* ?/gi,'')
    .replace(/(?<!\\)[{}]/g,'');
}
const looksRtf=s=>/^\s*\{\\rtf|\\pard?\b|\\b0\b/.test(s);

const BREAK_AFTER=/^\/(p|div|li|tr|h[1-6]|table|blockquote)$/;
// e-Sword HTML to the markup above. The TSK closes spans it never opened
// ("</ref></span>"), so formatting is tracked on a stack that ignores a closer
// with nothing to close, rather than by matching tags in pairs.
export function cmtiToMarkup(html,decodeNamed){
  let src=String(html||'').replace(/\r/g,'');
  if(looksRtf(src))src=rtfToHtml(src);
  const lines=[];
  let line='',on={b:false,i:false},stack=[],ref=null;
  const want=()=>({b:stack.some(f=>f.b),i:stack.some(f=>f.i)});
  const emit=text=>{
    if(!text)return;
    const w=want();
    // Close in reverse order of opening, open in order, so tags nest.
    if(on.i&&!w.i){line+='</i>';on.i=false;}
    if(on.b&&!w.b){if(on.i){line+='</i>';on.i=false;}line+='</b>';on.b=false;}
    if(w.b&&!on.b&&text.trim()){if(on.i){line+='</i>';on.i=false;}line+='<b>';on.b=true;}
    if(w.i&&!on.i&&text.trim()){line+='<i>';on.i=true;}
    line+=text;
  };
  const endLine=()=>{
    if(on.i)line+='</i>';
    if(on.b)line+='</b>';
    on={b:false,i:false};
    const t=line.replace(/\s+/g,' ').replace(/<(b|i)>\s*<\/\1>/g,'').trim();
    if(t)lines.push(t);
    line='';
  };
  const re=/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m;
  while((m=re.exec(src))){
    if(m[4]!==undefined){
      const text=decodeEntities(m[4],decodeNamed);
      if(ref)ref.text+=text;
      else emit(escapeText(text));
      continue;
    }
    const close=m[1]==='/',tag=m[2].toLowerCase(),attrs=m[3]||'';
    if(tag==='ref'){
      if(!close){ref={text:''};continue;}
      if(!ref)continue;
      // One the parser cannot read stays as the text it was.
      const raw=ref.text,r=refToken(raw);ref=null;
      if(r){emit(r.token);if(r.rest)emit(escapeText(r.rest));}
      else emit(escapeText(raw));
      continue;
    }
    if(tag==='br'){endLine();continue;}
    if(tag==='td'||tag==='th'){if(close)emit(' ');continue;}
    if(BREAK_AFTER.test((close?'/':'')+tag)){endLine();continue;}
    if(tag==='span'||tag==='b'||tag==='strong'||tag==='i'||tag==='em'||tag==='font'){
      if(close){if(stack.length)stack.pop();continue;}
      if(/\/\s*$/.test(attrs))continue;
      const style=(attrs.match(/style\s*=\s*"([^"]*)"/i)||attrs.match(/style\s*=\s*'([^']*)'/i)||[])[1]||'';
      stack.push({
        b:tag==='b'||tag==='strong'||/font-weight\s*:\s*(bold|[6-9]00)/i.test(style),
        i:tag==='i'||tag==='em'||/font-style\s*:\s*italic/i.test(style),
      });
      continue;
    }
    // num (Strong's numbers in the TSK), a, sup and anything else: keep the text.
  }
  endLine();
  return lines.join('\n');
}

// The TSK "with Self References" opens every verse with that verse itself --
// its reference, then its KJV text in italics. The reader has the verse on the
// page already, in whichever version they read, so that line goes.
export function dropSelfLine(markup,b,c,v){
  const nl=markup.indexOf('\n');
  const first=nl<0?markup:markup.slice(0,nl);
  const own=new RegExp(`^\\{${b}\\.${c}\\.${v}(-[\\d.]+)?\\}\\s*<i>`);
  return own.test(first)?(nl<0?'':markup.slice(nl+1)):markup;
}

// One line of markup to runs the page can draw: text with its bold and italic,
// or a reference.
const TOKEN=/<(\/?)([bi])>|\{(\d+)\.(\d+)\.(\d+)(?:-(\d+)(?:\.(\d+))?)?\}/g;
const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function markupRuns(line){
  const out=[];let b=false,i=false,last=0,m;
  TOKEN.lastIndex=0;
  const text=s=>{if(s)out.push({text:unescape(s),b,i});};
  while((m=TOKEN.exec(line))){
    text(line.slice(last,m.index));last=TOKEN.lastIndex;
    if(m[2]){const on=m[1]!=='/';if(m[2]==='b')b=on;else i=on;continue;}
    const bk=+m[3],c=+m[4],v=+m[5];
    let c2=c,v2=v;
    if(m[7]){c2=+m[6];v2=+m[7];}else if(m[6])v2=+m[6];
    out.push({ref:{b:bk,c,v,c2,v2},b,i});
  }
  text(line.slice(last));
  return out;
}
