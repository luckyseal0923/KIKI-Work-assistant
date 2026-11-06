// Standard, uncached text-token list prices verified 2026-11-07; estimates, not invoices.
export const PRICE_AS_OF='2026-11-07';
const RATES={'gpt-6-luna':[0.10,0.50],'gpt-6.1-sol':[2,10],'gpt-6-astra':[10,50]};
export function estimateModelCost(model,input,output){
  const rate=RATES[model];
  if(!rate||![input,output].every(v=>Number.isSafeInteger(v)&&v>=0))return null;
  return (input*rate[0]+output*rate[1])/1000000;
}
export function summarizeUsage(rows){
  const out={today:{usd:0,input:0,output:0,unpriced:0},month:{usd:0,input:0,output:0,unpriced:0},asOf:PRICE_AS_OF};
  for(const row of rows){
    const amount=estimateModelCost(row.model_name,Number(row.input_tokens||0),Number(row.output_tokens||0));
    for(const target of [out.month,...(row.period==='today'?[out.today]:[])]){
      target.input+=Number(row.input_tokens||0);target.output+=Number(row.output_tokens||0);
      if(amount===null)target.unpriced+=Number(row.requests||0);else target.usd+=amount;
      target.unpriced+=Number(row.incomplete||0);
    }
  }
  return out;
}
