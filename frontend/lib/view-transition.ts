import './view-transition.css';

type Scene='settings-open'|'settings-close'|'clock'|'window';
let active:ViewTransition|undefined,queue=Promise.resolve();
export function motionDisabled(){return document.documentElement.dataset.appReducedMotion==='true'||matchMedia('(prefers-reduced-motion: reduce)').matches;}
export function viewTransition(update:()=>void|Promise<unknown>,scene:Scene,reduce=motionDisabled()):Promise<void>{
 const run=async()=>{
  if(active){active.skipTransition();await active.updateCallbackDone.catch(()=>{});}
  if(reduce||!document.startViewTransition){await update();return;}
  let applying:Promise<unknown>|undefined;
  const apply=()=>{applying??=Promise.resolve().then(update);return applying.then(()=>{});};
  const root=document.documentElement;root.dataset.sceneTransition=scene;
  let transition:ViewTransition;
  try{transition=document.startViewTransition(apply);}catch{delete root.dataset.sceneTransition;await apply();return;}
  active=transition;
  // Hidden WebViews and older compositors may skip the visual snapshot. The
  // update still runs once; neither rejection should repeat a native action.
  void transition.ready.catch(()=>{});
  void transition.finished.catch(()=>{}).finally(()=>{if(active===transition){active=undefined;delete root.dataset.sceneTransition;}});
  try{await transition.updateCallbackDone;await transition.ready.catch(()=>{});}catch(error){if(applying)await applying;else{delete root.dataset.sceneTransition;throw error;}}
 };
 const task=queue.catch(()=>{}).then(run);queue=task;return task;
}
export function cancelSceneTransition(){active?.skipTransition();}
export function animateWindowEntry(){
 if(motionDisabled()||document.visibilityState!=='visible')return;
 const scene=document.querySelector<HTMLElement>('.timer-stage');
 scene?.animate?.([{opacity:.4,transform:'translateY(2px)'},{opacity:1,transform:'none'}],{duration:140,easing:'ease-out'});
}
