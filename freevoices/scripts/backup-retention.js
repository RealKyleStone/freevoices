#!/usr/bin/env node
/** Prune only old encrypted FreeVoices backups from an explicit directory. */
const fs=require('fs');
const path=require('path');
const args=process.argv.slice(2);
const dirIndex=args.indexOf('--dir');
const requested=dirIndex>=0 ? args[dirIndex+1] : path.join(__dirname,'..','backups');
if(!requested) throw new Error('Choose a backup directory');
if(!fs.existsSync(requested)) { console.log('No backup directory exists yet; no files to remove.'); process.exit(0); }
const directory=fs.realpathSync(path.resolve(requested));
const days=30;
const cutoff=Date.now()-days*86400000;
const apply=args.includes('--apply');
let candidates=0;
for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  if(!entry.isFile() || !/^freevoices_[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T[\d-]+\.fvbak$/.test(entry.name)) continue;
  const full=path.resolve(directory,entry.name);
  if(path.dirname(full)!==directory || fs.lstatSync(full).isSymbolicLink()) continue;
  if(fs.statSync(full).mtimeMs>=cutoff) continue;
  candidates++;
  if(apply) fs.unlinkSync(full);
}
console.log(`${apply ? 'Removed' : 'Would remove'} ${candidates} encrypted backups older than ${days} days in ${directory}.`);
