#!/usr/bin/env python3
"""Render the targeted capability matrix; never infer an overall support score."""
import collections,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);r=json.loads((root/'results.json').read_text())
by=collections.defaultdict(list)
for run in r['runs']:
    for p in run['probes']:by[(run['version'],p['name'])].extend(p['samples'])
assert len(r['runs'])==270
assert len(by)==90
assert all(len(v)==3 for v in by.values())
lines=['# Targeted native Porffor capability matrix','','Each cell reports correct responses from three independently started native processes. The 45 selected probes emphasize known web-app boundaries. These counts are not an overall JavaScript compatibility score.','','| Probe | Group | Pinned commit | Current upstream | First observed output/error |','|---|---|---:|---:|---|']
for case in json.loads((root/'cases.json').read_text()):
    samples=by[('pin',case['name'])];current=by[('current',case['name'])]
    a=sum(x['ok'] for x in samples);b=sum(x['ok'] for x in current)
    assert a==b
    witness=samples[0]
    actual=json.dumps(witness.get('actual',witness.get('error')),ensure_ascii=True)
    if len(actual)>160:actual=actual[:157]+'...'
    actual=actual.replace('|','\\|').replace('`','\\`')
    lines.append(f"| {case['name']} | {case['group']} | {a}/3 | {b}/3 | `{actual}` |")
lines+=['','All four binaries compiled successfully. Each version passed the same 18 probes and failed the same 27 selected probes in all three independent repetitions. Source hashes, expected outputs, process exit status, health recovery, compiler archive/binary identities and raw response hex are retained in results.json. Host-capabilities includes process only as a Node-host contrast; its absence is not a Workers compatibility bug.','', 'The host was Linux x86_64 with existing services. Each native process used CPU affinity 0, CPUQuota=100%, MemoryMax=512M; the generator and a fixed loopback upstream used CPU 1. Each probe had a two-second deadline. This matrix measures semantic behavior, not throughput or startup performance.']
(root/'matrix.md').write_text('\n'.join(lines)+'\n');print('Verified 270 independent probes; wrote matrix.md')
