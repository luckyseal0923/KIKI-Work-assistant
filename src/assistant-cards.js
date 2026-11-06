import {createHmac,timingSafeEqual} from 'node:crypto';

const ACTIONS={confirm:'確認',discard:'取消提案',finish:'完成工作',cancel:'取消工作',history:'工作歷程',list:'工作清單',topics:'主題清單',topic:'主題'};
const validTarget=(action,target,version)=>action==='list'||action==='topics'?target==='-'&&version===0:
  ['confirm','discard'].includes(action)?/^P[0-9A-F]{8}$/u.test(target)&&version===0:
  action==='topic'?/^T[0-9A-F]{8}$/u.test(target)&&version>0:/^W[0-9A-F]{8}$/u.test(target)&&version>0;
const mac=(config,value)=>createHmac('sha256',config.secret).update('kiki-card-v1\0'+config.allowedGroupId+'\0'+config.assistant.operatorUserId+'\0'+value).digest().subarray(0,16);

export function cardData(config,action,target='-',version=0,expires=Date.now()+1800000){
  if(!ACTIONS[action]||!Number.isSafeInteger(version)||!validTarget(action,target,version)||!Number.isSafeInteger(expires))throw new Error('invalid_card_action');
  const value=`k1.${action}.${target}.${version}.${expires}`;
  return value+'.'+mac(config,value).toString('base64url');
}
export function readCardAction(data,config,now=Date.now()){
  if(typeof data!=='string'||data.length>300)return null;
  const parts=data.split('.');if(parts.length!==6||parts[0]!=='k1')return null;
  const [,action,target,v,exp,signature]=parts,version=Number(v),expires=Number(exp);
  if(!ACTIONS[action]||!/^\d+$/u.test(v)||!/^\d+$/u.test(exp)||!Number.isSafeInteger(version)||!Number.isSafeInteger(expires)
    ||expires<=now||expires>now+1800000||!validTarget(action,target,version)||!/^[A-Za-z0-9_-]{22}$/u.test(signature))return null;
  const actual=Buffer.from(signature,'base64url'),expected=mac(config,parts.slice(0,5).join('.'));
  if(actual.toString('base64url')!==signature||actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
  const command=['list','topics'].includes(action)?ACTIONS[action]:`${ACTIONS[action]} ${target}${['finish','cancel'].includes(action)?` ${version}`:''}`;
  return {action,target,version,expires,command};
}

const label={confirm:'確認提案',discard:'取消提案',finish:'完成工作',cancel:'取消工作',history:'查看歷程',list:'工作清單',topics:'主題清單',topic:'查看主題'};
export function cardButtons(config,specs){
  return specs.map(s=>({type:'button',height:'sm',style:s.action==='confirm'?'primary':'secondary',action:{type:'postback',label:label[s.action],
    data:cardData(config,s.action,s.code||'-',s.version||0,s.expires||Date.now()+1800000)}}));
}
export function flexReply(config,text,specs=[]){
  if(!specs.length)return text;
  // Text retains the full preview and the command fallback; never truncate a mutation preview.
  return {type:'flex',altText:text.slice(0,1200),contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[
    {type:'text',text,wrap:true,size:'sm'}]},footer:{type:'box',layout:'vertical',spacing:'sm',contents:cardButtons(config,specs.slice(0,8))}}};
}
