#!/usr/bin/env python3
"""Wrap or unwrap inline fontSize literals in src/App.jsx.

  forward:  fontSize:13  ->  fontSize:U(13)
  reverse:  fontSize:U(13) -> fontSize:13

Tier is chosen by size alone, which matches how the file already uses type:
10 and under is the Cinzel micro-label band, 11-16 is UI body copy, 17 and up
is headings. Numbers are preserved verbatim so the reverse pass restores the
file byte for byte.

Ranges are 1-based inclusive line numbers; omit them to treat the whole file.
"""
import re,sys

FWD=re.compile(rb'fontSize:(\d+(?:\.\d+)?)(?=[,}\s])')
REV=re.compile(rb'fontSize:U[LH]?\((\d+(?:\.\d+)?)\)')

def tier(n):
    return b'UL' if n<=10 else (b'UH' if n>=17 else b'U')

def convert(data,ranges,reverse):
    lines=data.split(b'\n')
    hits=0
    for i,ln in enumerate(lines):
        n=i+1
        if ranges and not any(a<=n<=b for a,b in ranges): continue
        if reverse:
            ln,c=REV.subn(rb'fontSize:\1',ln)
        else:
            def rep(m):
                return b'fontSize:'+tier(float(m.group(1)))+b'('+m.group(1)+b')'
            ln,c=FWD.subn(rep,ln)
        hits+=c
        lines[i]=ln
    return b'\n'.join(lines),hits

if __name__=='__main__':
    args=sys.argv[1:]
    reverse='--reverse' in args
    args=[a for a in args if a!='--reverse']
    path=args[0]
    ranges=[tuple(int(x) for x in a.split('-')) for a in args[1:]]
    data=open(path,'rb').read()
    out,hits=convert(data,ranges,reverse)
    open(path,'wb').write(out)
    print(('unwrapped' if reverse else 'wrapped'),hits,'sites')
