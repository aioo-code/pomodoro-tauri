import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {LoaderCircle,Pause,Play,Volume2,VolumeX} from 'lucide-react';
import {audioState,playNoise,previewVolume,stopNoise,subscribeAudio} from '@/lib/audio';
import {noiseTextures} from '@/lib/audio-dsp';
import {customSoundsState,loadCustomSounds,subscribeCustomSounds} from '@/lib/custom-sounds';
import {saveReminderAudio,usePreferences} from '@/lib/preferences';
import {t} from '@/lib/i18n';
import ElasticSlider from '@/components/reactbits/ElasticSlider';
import {useReducedMotion} from '@/hooks/use-reduced-motion';

export function ReminderAudio({compact=false}:{compact?:boolean}) {
  const {values,saving}=usePreferences(),audio=useSyncExternalStore(subscribeAudio,audioState),library=useSyncExternalStore(subscribeCustomSounds,customSoundsState);
  const reducedMotion=useReducedMotion();
  const [draft,setDraft]=useState(values.noiseVolume),latest=useRef(draft),lastAudible=useRef(values.noiseVolume||22);
  useEffect(()=>{void loadCustomSounds();},[]);
  useEffect(()=>{latest.current=values.noiseVolume;setDraft(values.noiseVolume);if(values.noiseVolume)lastAudible.current=values.noiseVolume;},[values.noiseVolume]);
  const commit=()=>{if(latest.current!==values.noiseVolume&&!saving)void saveReminderAudio({noiseVolume:latest.current}).then(ok=>{if(!ok){latest.current=values.noiseVolume;setDraft(values.noiseVolume);previewVolume(values.noiseVolume);}});};
  const texture=noiseTextures.find(item=>item.id===values.noiseTexture)??noiseTextures[0];
  const custom=library.sounds.find(sound=>sound.id===values.customNoiseId),name=values.customNoiseId?custom?.name??t('本地音频'):t(texture.label);
  const choices=[...noiseTextures.map(item=>({noiseTexture:item.id,customNoiseId:''})),...library.sounds.map(sound=>({noiseTexture:values.noiseTexture,customNoiseId:sound.id}))];
  const selected=choices.findIndex(choice=>values.customNoiseId?choice.customNoiseId===values.customNoiseId:!choice.customNoiseId&&choice.noiseTexture===values.noiseTexture);
  const preparing=audio.status==='loading'&&!audio.preview;
  const playing=(audio.playing||preparing)&&!audio.preview;
  const toggle=()=>{if(playing)void stopNoise();else void playNoise();};
  if(compact)return <button type="button" className="window-button reminder-audio-compact" aria-label={t(playing?'暂停冥想音':'播放冥想音')} aria-pressed={playing} onClick={toggle}>{values.audioMuted?<VolumeX/>:preparing?<LoaderCircle className="audio-loading"/>:playing?<Volume2/>:<VolumeX/>}</button>;
  return <div className="reminder-audio" aria-label={t('冥想氛围')}>
    <button type="button" id="noise-play" className="noise-play" aria-label={t(playing?'暂停冥想音':'播放冥想音')} aria-pressed={playing} onClick={toggle}>{preparing?<LoaderCircle className="audio-loading"/>:playing?<Pause/>:<Play/>}</button>
    <button type="button" id="noise-texture" className="noise-name" aria-label={t('切换冥想音色')} title={name} disabled={saving} onClick={()=>void saveReminderAudio(choices[(selected+1)%choices.length])}><span>{name}</span><small>{t(values.audioMuted?'静音模式':preparing?'正在准备…':audio.status==='blocked'?'点击播放，开启环境音。':'冥想氛围')}</small></button>
    <button type="button" id="noise-mute" className="noise-mute" aria-label={t(values.audioMuted?'静音模式已开启':draft===0?'取消静音':'静音')} disabled={saving||values.audioMuted} onClick={()=>void saveReminderAudio({noiseVolume:draft===0?lastAudible.current:0})}>{values.audioMuted||draft===0?<VolumeX/>:<Volume2/>}</button>
    <ElasticSlider id="reminder-volume" label={t('冥想音量')} value={draft} disabled={saving} reducedMotion={reducedMotion} maxStretch={4} trackHeight={2} onChange={value=>{latest.current=value;setDraft(value);previewVolume(value);}} onChangeEnd={commit}/>
    {audio.status==='unavailable'&&<span className="sr-only" role="status">{t('音频暂不可用，请检查系统音频设备。')}</span>}
  </div>;
}
