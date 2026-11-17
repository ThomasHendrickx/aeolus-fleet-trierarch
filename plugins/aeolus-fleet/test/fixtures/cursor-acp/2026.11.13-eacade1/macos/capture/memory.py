from probe import *
c=Client('idle-memory-tree','lifecycle')
try:
 c.init();r=c.new();original=r['result']['models']['currentModelId'];c.model('composer-2.5[fast=true]');c.prompt('Reply exactly ACP_MAC_IDLE_MEMORY. Use no tools.');time.sleep(3)
 table={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,rss='],text=True).splitlines():
  pid,parent,rss=map(int,line.split());table[pid]=(parent,rss)
 owned={c.p.pid};changed=True
 while changed:
  children={pid for pid,(parent,rss) in table.items() if parent in owned};new=children-owned;changed=bool(new);owned.update(new)
 root=table.get(c.p.pid,(0,0))[1];total=sum(table.get(pid,(0,0))[1] for pid in owned)
 c.log('observation',{'event':'idle-tree-rss','parentKilobytes':root,'treeKilobytes':total,'processCount':len(owned),'scope':'owned agent acp PID and descendants after a completed tool-free prompt and three idle seconds','caveat':'RSS sums shared pages more than once; not proportional set size'})
finally:
 try:c.model(original)
 finally:c.close()
