#!/usr/bin/env python3
"""Plain pinned Porffor: retain failures, measure only a validated workload."""
import pathlib
# Reuse the exact request validation, memory sampling and startup gate helpers
# used by the three-runtime pilot, without executing its comparison loop.
helper=pathlib.Path(__file__).with_name('measure.py')
exec(compile(helper.read_text().split('\ncorpus=')[0],str(helper),'exec'))
def probe(port,p):
    result=request(port,p)
    if not result['ok']:
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
        try:
            headers={'content-type':'application/json'}
            if 'signature' in p:headers['x-signature']=p['signature']
            c.request(p.get('method','GET'),p['path'],body=p.get('body','').encode(),headers=headers)
            response=c.getresponse();body=response.read()
            result['diagnostic']={'status':response.status,'type':response.getheader('content-type'),'bodyPreview':body[:300].decode(errors='replace'),'bodyBytes':len(body),'bodySha256':hashlib.sha256(body).hexdigest()}
        except Exception as e:result['diagnostic']={'error':str(e)}
        finally:c.close()
    return result

corpus=json.loads((ROOT/'corpus.json').read_text());health=corpus[0]
order=next(p for p in corpus if p['name']=='small order')
report={'label':'Plain pinned Porffor shared-host diagnostic, not a complete app comparison','dateUTC':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'plain':json.loads((ROOT/'plain-manifest.json').read_text()),'machine':{'uname':list(os.uname()),'loadBefore':os.getloadavg()},'runs':[]}
log=(ROOT/'plain-runtime.log').open('w')
env=dict(os.environ,PORT='18081')
with socket.socket() as s:s.bind(('127.0.0.1',18081))
with socket.socket() as s:s.bind(('127.0.0.1',18082))
upstream=subprocess.Popen(['taskset','-c','1',str(TOOLS/'node'),str(ROOT/'adapters/upstream.mjs')],env=env,stdout=log,stderr=log)
try:
    for _ in range(200):
        if request(18081,dict(health,type=''))['ok']:break
        time.sleep(.01)
    else:raise RuntimeError('Upstream readiness failed')
    for variant,repeat in [('full',0),('subset',0),('subset',1),('subset',2)]:
        cmd=[str(ROOT/('porffor-'+variant))]
        proc=subprocess.Popen(['systemd-run','--user','--scope','--quiet','-p','MemoryMax=512M','-p','CPUQuota=100%','taskset','-c','0',sys.executable,str(ROOT/'measure.py'),'--gate',*cmd],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        gate=None;row={'runtime':'plain-porffor-'+variant,'repeat':repeat};report['runs'].append(row)
        try:
            gate=json.loads(proc.stdout.readline());row['gate']=gate
            start=time.perf_counter();proc.stdin.write('\n');proc.stdin.flush()
            for _ in range(1000):
                if request(18082,health)['ok']:break
                if proc.poll() is not None:raise RuntimeError('Process exited before ready')
                time.sleep(.001)
            else:raise RuntimeError('Readiness timeout')
            row['startupMs']=(time.perf_counter()-start)*1000
            row['correctness']=[]
            for p in corpus:
                row['correctness'].append(dict(name=p['name'],**probe(18082,p)))
                if proc.poll() is not None:row['processExitedDuringCorrectness']=True;break
            time.sleep(1);row['idleMemory']=memory(gate['pid'])
            # Invalid Unicode/crypto/upstream results remain visible. Only the
            # independently validated ASCII order can qualify for load tests.
            if not request(18082,order)['ok']:row['traffic']='ineligible: small order failed';continue
            for _ in range(100):request(18082,order);time.sleep(.02)
            samples=[];dropped=0;mem=[];start=time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                pending=[]
                for i in range(500):
                    due=start+i/50;time.sleep(max(0,due-time.perf_counter()))
                    if time.perf_counter()-due>.1:dropped+=1;continue
                    pending.append(pool.submit(request,18082,order))
                    if i%50==0:mem.append(memory(gate['pid']))
                samples=[f.result() for f in pending]
            lat=sorted(s['ms'] for s in samples)
            row['workload']={'name':'order','attempted':500,'correct':sum(s['ok'] for s in samples),'generatorDropped':dropped,'rate':50,'seconds':10,'samples':samples,'memorySamples':mem,'p95Ms':lat[int(.95*(len(lat)-1))]}
            cg=gate['cgroup'].strip().split(':')[-1];base=pathlib.Path('/sys/fs/cgroup')/cg.lstrip('/')
            row['cgroup']={f:(base/f).read_text() for f in ['memory.current','memory.peak','memory.max','cpu.stat','cpu.max'] if (base/f).exists()}
        except Exception as e:row['failure']=str(e)
        finally:
            if gate is not None:
                try:os.kill(gate['pid'],15)
                except ProcessLookupError:pass
            try:proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:proc.kill();proc.communicate()
            print(row['runtime'],repeat,'checks',sum(p['ok'] for p in row.get('correctness',[])),'traffic',row.get('workload',{}).get('correct'),row.get('failure',''),flush=True)
            (ROOT/'plain-results.json').write_text(json.dumps(report,indent=2))
finally:
    upstream.terminate();upstream.wait(timeout=5);log.close()
    report['machine']['loadAfter']=os.getloadavg()
    (ROOT/'plain-results.json').write_text(json.dumps(report,indent=2))
