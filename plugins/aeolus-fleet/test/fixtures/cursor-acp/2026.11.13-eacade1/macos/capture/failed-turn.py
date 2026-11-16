from probe import *
c=Client('invalid-image','lifecycle')
try:
 c.init();r=c.new();original=r['result']['models']['currentModelId'];c.model('composer-2.5[fast=true]')
 r=c.request('session/prompt',{'sessionId':c.sid,'prompt':[{'type':'text','text':'Describe the attached image in one sentence. Use no tools.'},{'type':'image','mimeType':'image/png','data':'bm90LWFuLWltYWdl'}]})
 c.log('observation',{'event':'invalid-image-prompt','result':r.get('result'),'error':r.get('error'),'initializedTurnFailureProven':'error' in r})
finally:
 try:c.model(original)
 finally:c.close()
