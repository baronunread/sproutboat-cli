#!/usr/bin/env python3
"""Repeat independent semantic probes with bounded native process resources."""
import pathlib
helper=pathlib.Path(__file__).with_name('measure.py')
exec(compile(helper.read_text().split('\ncorpus=')[0],str(helper),'exec'))
cases=json.loads((ROOT/'cases.json').read_text());manifest=json.loads((ROOT/'manifest.json').read_text())
report={'manifest':manifest,'dateUTC':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'machine':{'uname':list(os.uname()),'memory':pathlib.Path('/proc/meminfo').read_text(),'loadBefore':os.getloadavg()},'requestDeadlineSeconds':2,'repetitionsPerProbe':3,'runs':[]}
log=(ROOT/'runtime.log').open('w')
env=dict(os.environ,PORT='18081')
for n in (18081,18082):
    with socket.socket() as s:s.bind(('127.0.0.1',n))
upstream=subprocess.Popen(['taskset','-c','1',str(TOOLS/'node'),str(ROOT/'upstream.mjs')],env=env,stdout=log,stderr=log)

def probe(case):
    start=time.perf_counter();c=http.client.HTTPConnection('127.0.0.1',18082,timeout=2)
    try:
        body=case.get('body');path='/'+case['name']+'?q=caff%C3%A8%20%F0%9F%9A%A4'
        c.request('POST' if body is not None else 'GET',path,body=body.encode() if body is not None else None,headers={'content-type':'application/json'})
        r=c.getresponse();raw=r.read();text=raw.decode()
        value=json.loads(text) if r.getheader('content-type','').startswith('application/json') else text
        return {'ok':r.status==case.get('status',200) and value==case['expected'],'status':r.status,'actual':value,'rawHex':raw[:200].hex(),'ms':(time.perf_counter()-start)*1000}
    except Exception as e:return {'ok':False,'error':str(e),'rawHex':raw[:200].hex() if 'raw' in locals() else None,'ms':(time.perf_counter()-start)*1000}
    finally:c.close()

try:
    for _ in range(200):
        if request(18081,{'path':'/health','status':200,'expected':'ok','type':''})['ok']:break
        time.sleep(.01)
    else:raise RuntimeError('Upstream readiness failed')
    for v in manifest['versions']:
        for attempt,case,repetition in [(a,c,i) for a in v['attempts'] for c in cases if bool(c.get('async'))==a['name'].endswith('-async') and ('probe' not in a or a['probe']==c['name']) for i in range(3)]:
            row={'version':v['name'],'binary':attempt['name'],'compileCode':attempt['code'],'probeName':case['name'],'repetition':repetition,'probes':[]};report['runs'].append(row)
            if attempt['code']!=0:continue
            proc=subprocess.Popen(['systemd-run','--user','--scope','--quiet','-p','MemoryMax=512M','-p','CPUQuota=100%','taskset','-c','0',sys.executable,str(ROOT/'measure.py'),'--gate',str(ROOT/attempt['name'])],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
            gate=None
            try:
                gate=json.loads(proc.stdout.readline());row['gate']=gate;proc.stdin.write('\n');proc.stdin.flush()
                for _ in range(1000):
                    if request(18082,{'path':'/health','status':200,'expected':'ok','type':''})['ok']:break
                    if proc.poll() is not None:raise RuntimeError('Process exited before ready')
                    time.sleep(.001)
                else:raise RuntimeError('Readiness timeout')
                samples=[probe(case)]
                recovery=request(18082,{'path':'/health','status':200,'expected':'ok','type':''})
                row['probes'].append({'name':case['name'],'group':case['group'],'expected':case['expected'],'samples':samples,'healthAfter':recovery})
                row['candidateExitCode']=proc.poll()
                print(v['name'],case['name'],repetition, sum(s['ok'] for s in samples),'/1',flush=True)
                (ROOT/'results.json').write_text(json.dumps(report,indent=2))
                cg=gate['cgroup'].strip().split(':')[-1];base=pathlib.Path('/sys/fs/cgroup')/cg.lstrip('/')
                row['cgroup']={f:(base/f).read_text() for f in ['memory.peak','cpu.stat','memory.events'] if (base/f).exists()}
            except Exception as e:row['failure']=str(e)
            finally:
                if gate is not None:
                    try:os.kill(gate['pid'],15)
                    except ProcessLookupError:pass
                try:proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:proc.kill();proc.communicate()
finally:
    upstream.terminate();upstream.wait(timeout=5);log.close()
    report['machine']['loadAfter']=os.getloadavg()
    (ROOT/'results.json').write_text(json.dumps(report,indent=2))
