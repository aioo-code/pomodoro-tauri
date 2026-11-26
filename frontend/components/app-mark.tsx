import {iconChoices} from '@/lib/icon-choices';
import {usePreferences} from '@/lib/preferences';

export function AppMark() {
  const {values}=usePreferences();
  const icon=iconChoices.find(item=>item.id===values.icon)??iconChoices[0];
  return <img className="app-mark" src={icon.image} data-app-icon={icon.id} alt="" draggable={false} aria-hidden="true"/>;
}
