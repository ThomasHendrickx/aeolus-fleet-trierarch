import json,os,pathlib,re,shutil,signal,subprocess,time
root=pathlib.Path(__file__).resolve().parent
workspace=root/'workspace'
env={k:v for k,v in os.environ.items() if not k.startswith(('AEOLUS_','CLAUDE','CODEX','CURSOR_')) and k not in {'GH_TOKEN','GITHUB_TOKEN','COPILOT_GITHUB_TOKEN'}}
(workspace/'.cursor').mkdir(parents=True,exist_ok=True)
subprocess.run(['git','init','-q'],cwd=workspace,check=True)
shutil.copyfile(root/'probe.py',workspace/'.cursor/probe.py')
hooks={event:[{'command':'python3 '+str(workspace/'.cursor/probe.py')+' '+event}] for event in ['sessionStart','preToolUse','postToolUse','postToolUseFailure','stop','sessionEnd']}
(workspace/'.cursor/hooks.json').write_text(json.dumps({'version':1,'hooks':hooks},indent=2)+'\n')
def capture(name,mode,prompt,session=None,interrupt=False):
    for name_ in ['hooks.jsonl','started','active','hand-over-confirmed']:
        (workspace/name_).unlink(missing_ok=True)
    (workspace/'mode').write_text(mode)
    args=['agent','-p',prompt,'--output-format','stream-json','--trust']+(['--force'] if mode=='report' else [])+(['--resume',session] if session else [])
    steps=[]
    with (root/(name+'.stdout')).open('w') as out,(root/(name+'.stderr')).open('w') as err:
        proc=subprocess.Popen(args,cwd=workspace,env=env,stdout=out,stderr=err,start_new_session=True)
        steps.append({'event':'process-start','turn':'busy'})
        deadline=time.monotonic()+90
        sent=False
        while proc.poll() is None:
            text=(workspace/'hooks.jsonl').read_text() if (workspace/'hooks.jsonl').exists() else ''
            if interrupt and not sent and '"event": "preToolUse"' in text:
                time.sleep(1)
                proc.send_signal(signal.SIGINT)
                steps.append({'event':'signal','signal':'SIGINT','after':'preToolUse','target':'owned agent PID'})
                sent=True
            if time.monotonic()>deadline:
                os.killpg(proc.pid,signal.SIGTERM)
                proc.wait(timeout=10)
                steps.append({'event':'timeout','signal':'SIGTERM','target':'owned process group'})
                break
            time.sleep(.1)
        status=proc.wait()
        time.sleep(2)
    steps.append({'event':'process-exit','turn':'idle','exitStatus':status})
    stdout=(root/(name+'.stdout')).read_text()
    events=[json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
    hooklog=[json.loads(line) for line in (workspace/'hooks.jsonl').read_text().splitlines()] if (workspace/'hooks.jsonl').exists() else []
    data={'command':args,'exitStatus':status,'stdout':stdout,'stderr':(root/(name+'.stderr')).read_text(),'hooks':hooklog,'process':steps,'markers':{marker:(workspace/marker).read_text().strip() for marker in ['started','active','hand-over-confirmed'] if (workspace/marker).exists()}}
    (root/(name+'.json')).write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps({'name':name,'exit':status,'hooks':[h['event'] for h in hooklog],'finalStatus':[h['input'].get('final_status') for h in hooklog if h['event']=='sessionEnd'],'result':events[-1].get('result') if events else None,'process':steps}),flush=True)
    return next((e.get('session_id') for e in events if e.get('session_id')),None)
session=capture('deny-fresh','deny','Run the shell command printf S7_MAC_TOOL_PROBE. Then state all exact context markers you received.')
capture('deny-resume','deny','Run the shell command printf S7_MAC_RESUME_TOOL_PROBE. Then state all exact context markers you received.',session)
session=capture('report-fresh','report','Run the shell command printf S7_MAC_ALLOWED_TOOL. Then state all exact context markers you received.')
capture('report-resume','report','Run the shell command printf S7_MAC_ALLOWED_RESUME. Then state all exact context markers you received.',session)
session=capture('tool-free-fresh','tool-free','Call no tools. Reply exactly S7_MAC_TOOL_FREE_FRESH.')
capture('tool-free-resume','tool-free','Call no tools. Reply exactly S7_MAC_TOOL_FREE_RESUME.',session)
session=capture('interrupted-fresh','interrupt','Run the shell command sleep 30. Then reply DONE.',interrupt=True)
if session: capture('interrupted-resume','interrupt','Run the shell command sleep 30. Then reply DONE.',session,interrupt=True)
