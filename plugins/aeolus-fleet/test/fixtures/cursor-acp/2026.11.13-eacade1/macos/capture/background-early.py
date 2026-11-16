from probe import *
workspace=ROOT/'background-marker-workspace';workspace.mkdir(exist_ok=True)
conf=ROOT/'background-marker-config';conf.mkdir(exist_ok=True)
c=Client('background-early','background-early',env={'CURSOR_CONFIG_DIR':str(conf)},cwd=workspace,option='allow-once')
try:
 c.init();c.new(cwd=str(workspace));c.model('composer-2.5[fast=true]')
 start=time.monotonic()
 c.prompt('Use the shell tool to run exactly: sleep 12; printf ACP_BG_DONE > background.done . Set the shell foreground timeout to 1000 milliseconds. Once it is running in the background, immediately reply STARTED and end this turn. Do not wait, poll, read files or run any other tools.',timeout=90)
 elapsed=round((time.monotonic()-start)*1000);atEnd=(workspace/'background.done').exists()
 deadline=time.monotonic()+20
 while time.monotonic()<deadline and not (workspace/'background.done').exists():time.sleep(0.25)
 c.log('observation',{'event':'background-at-end-turn','promptElapsedMs':elapsed,'markerAtEndTurn':atEnd,'markerLater':(workspace/'background.done').exists(),'markerContent':(workspace/'background.done').read_text() if (workspace/'background.done').exists() else None})
finally:c.close()
