import {createHmac} from 'node:crypto';

export function speakerLabel(userId,config){
  if(!userId)return '發言者未提供';
  if(userId===config.assistant.operatorUserId)return '管理者';
  return '成員'+createHmac('sha256',config.secret).update('kiki-speaker-v1\0'+config.allowedGroupId+'\0'+userId).digest('hex').slice(0,10).toUpperCase();
}

export function selectThreadRows(seeds,neighbors,maximum){
  const byId=new Map([...seeds,...neighbors].map(r=>[r.message_id,r]));
  const selected=new Map();
  const add=row=>{if(row&&selected.size<maximum)selected.set(row.message_id,row);};
  for(const seed of seeds){
    if(selected.size>=maximum)break;
    add(seed);
    let parent=seed;
    for(let depth=0;depth<2;depth++){parent=byId.get(parent?.quoted_message_id);add(parent);}
    let frontier=[seed];
    for(let depth=0;depth<2;depth++){
      const parentIds=new Set(frontier.map(r=>r.message_id));
      const replies=[...byId.values()].filter(r=>parentIds.has(r.quoted_message_id))
        .sort((a,b)=>new Date(b.effective_at)-new Date(a.effective_at)||b.message_id.localeCompare(a.message_id)).slice(0,4);
      for(const reply of replies)add(reply);frontier=replies;
    }
  }
  return [...selected.values()].sort((a,b)=>new Date(a.effective_at)-new Date(b.effective_at)||a.message_id.localeCompare(b.message_id));
}
