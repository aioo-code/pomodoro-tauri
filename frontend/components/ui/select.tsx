import * as React from 'react';
import {Select as SelectPrimitive} from 'radix-ui';
import {Check, ChevronDown, ChevronUp} from 'lucide-react';
import {cn} from '@/lib/utils';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;
function SelectTrigger({className,children,...props}:React.ComponentProps<typeof SelectPrimitive.Trigger>){
  return <SelectPrimitive.Trigger className={cn('select-trigger',className)} {...props}>{children}<SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true"/></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}
function SelectContent({className,children,...props}:React.ComponentProps<typeof SelectPrimitive.Content>){
  return <SelectPrimitive.Portal><SelectPrimitive.Content position="popper" align="end" sideOffset={6} collisionPadding={8} className={cn('select-content',className)} {...props}>
    <SelectPrimitive.ScrollUpButton className="select-scroll-button"><ChevronUp aria-hidden="true"/></SelectPrimitive.ScrollUpButton>
    <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
    <SelectPrimitive.ScrollDownButton className="select-scroll-button"><ChevronDown aria-hidden="true"/></SelectPrimitive.ScrollDownButton>
  </SelectPrimitive.Content></SelectPrimitive.Portal>;
}
function SelectItem({className,children,...props}:React.ComponentProps<typeof SelectPrimitive.Item>){
  return <SelectPrimitive.Item className={cn('select-item',className)} {...props}><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator className="select-item-indicator"><Check aria-hidden="true"/></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>;
}
export {Select,SelectTrigger,SelectValue,SelectContent,SelectItem};
