export function TimerMessage({quote,status,mini=false}:{quote:string;status:string;mini?:boolean}){
  return <p className={mini?'mini-message':'clock-status'} data-quote={!!quote} role="status" aria-label={status} title={quote||undefined}><span id="status" className={quote?'sr-only':undefined}>{status}</span>{quote&&<span className="quote-inline" aria-hidden="true">{quote}</span>}</p>;
}
