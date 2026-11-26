import {useRef,type ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {useChromaSpotlight} from '@/components/reactbits/use-chroma-spotlight';
import './focus-button.css';

export function FocusButton({label,icon,running,disabled,reducedMotion,onClick}:{
  label:string;icon:ReactNode;running:boolean;disabled:boolean;reducedMotion:boolean;onClick:()=>void;
}) {
  const ref=useRef<HTMLButtonElement>(null);
  useChromaSpotlight(ref,disabled,reducedMotion);
  return <Button ref={ref} id="toggle" type="button" className="focus-primary" aria-label={label} aria-pressed={running} disabled={disabled} data-running={running} data-reduced-motion={reducedMotion} onClick={onClick}>
    <span className="focus-primary__wash" aria-hidden="true"/>
    <span className="focus-primary__light" aria-hidden="true"/>
    <span className="focus-primary__rim" aria-hidden="true"/>
    <span className="focus-primary__content"><span className="focus-primary__icon" aria-hidden="true">{icon}</span><span>{label}</span></span>
  </Button>;
}
