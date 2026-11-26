import flow from '@/assets/icons/flow.svg';
import orbit from '@/assets/icons/orbit.svg';
import bloom from '@/assets/icons/bloom.svg';
import prism from '@/assets/icons/prism.svg';
import graphite from '@/assets/icons/graphite.svg';

export const iconChoices = [
  { id: 'flow', label: '番茄', image: flow },
  { id: 'orbit', label: '星轨', image: orbit },
  { id: 'bloom', label: '花语', image: bloom },
  { id: 'prism', label: '棱镜', image: prism },
  { id: 'graphite', label: '曜黑', image: graphite },
] as const;
export type IconChoice = typeof iconChoices[number]['id'];
