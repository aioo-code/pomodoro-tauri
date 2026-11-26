import {useEffect, useSyncExternalStore} from 'react';
import {CircleDot,LoaderCircle,Orbit,Pause,Play,Volume2,Waves} from 'lucide-react';
import {t} from '@/lib/i18n';
import {audioState, playCue, playNoise, previewVolume, stopNoise, subscribeAudio} from '@/lib/audio';
import {noiseTextures} from '@/lib/audio-dsp';
import {customSoundsState,subscribeCustomSounds} from '@/lib/custom-sounds';
import {savePreferences, usePreferences} from '@/lib/preferences';
import {CustomSoundsPanel} from '@/components/custom-sounds-panel';
import {SettingRange} from '@/components/setting-range';
import {Button} from '@/components/ui/button';

export function AudioSettings() {
  const {values,saving,loaded}=usePreferences(),audio=useSyncExternalStore(subscribeAudio,audioState),library=useSyncExternalStore(subscribeCustomSounds,customSoundsState);
  const disabled=saving||!loaded;
  const previewActive=audio.preview&&(audio.playing||audio.status==='loading');
  const textureIcons={still:Waves,space:Orbit,bowl:CircleDot};
  const selected=noiseTextures.find(texture=>texture.id===values.noiseTexture)??noiseTextures[0];
  const custom=library.sounds.find(sound=>sound.id===values.customNoiseId);
  useEffect(()=>()=>{if(audioState().preview)void stopNoise(.15);},[]);
  const toggle=(id:string,label:string,detail:string,checked:boolean,onChange:()=>void)=><label className="audio-toggle" htmlFor={id}><span><span className="setting-label">{t(label)}</span><span className="setting-detail">{t(detail)}</span></span><button id={id} type="button" role="switch" className="setting-switch" aria-label={t(label)} aria-checked={checked} disabled={disabled} onClick={onChange}><span/></button></label>;
  return <section className="settings-group audio-settings" aria-labelledby="audio-heading"><h2 id="audio-heading"><span>{t('声音')}</span>{values.audioMuted&&<span className="audio-muted-status">{t('静音模式')}</span>}</h2>
    <div className="audio-card" aria-label={t('交互音效')}>
    {toggle('setting-sounds','交互音效','轻柔回应开始、暂停和选择操作',values.interactionSounds,()=>void savePreferences({interactionSounds:!values.interactionSounds}))}
    <SettingRange elastic id="setting-sound-volume" label={t('音效音量')} value={values.interactionVolume} min={0} max={100} disabled={disabled} format={value=>`${value}%`} left={t('静音')} right={t('更响亮')} save={interactionVolume=>savePreferences({interactionVolume})}/>
    <Button id="preview-cue" variant="ghost" className="audio-preview" disabled={disabled||values.audioMuted||values.interactionVolume===0} onClick={()=>void playCue('start',true)}><Volume2/>{t('试听音效')}</Button>
    </div>
    <div className="audio-card" aria-label={t('冥想氛围')}>
    {toggle('setting-reminder-noise','冥想氛围','到时柔和淡入，关闭提醒即停止',values.reminderNoise,()=>void savePreferences({reminderNoise:!values.reminderNoise}))}
    <div className="noise-choices" role="group" aria-label={t('冥想音色')} aria-describedby="noise-description">{noiseTextures.map(texture=>{const Icon=textureIcons[texture.id];return <button type="button" key={texture.id} data-texture={texture.id} aria-pressed={!values.customNoiseId&&values.noiseTexture===texture.id} disabled={disabled} title={t(texture.detail)} onClick={()=>void savePreferences({noiseTexture:texture.id,customNoiseId:''})}><Icon aria-hidden="true"/><span>{t(texture.label)}</span></button>;})}</div>
    <p id="noise-description" className="noise-description">{values.customNoiseId?custom?.name??t('本地音频'):t(selected.detail)}</p>
    <CustomSoundsPanel disabled={disabled}/>
    <SettingRange elastic id="setting-noise-volume" label={t('冥想音量')} value={values.noiseVolume} min={0} max={100} disabled={disabled} format={value=>`${value}%`} left={t('静音')} right={t('更响亮')} onPreview={previewVolume} save={noiseVolume=>savePreferences({noiseVolume})}/>
    <Button id="preview-noise" variant="ghost" className="audio-preview" aria-pressed={previewActive} aria-busy={audio.preview&&audio.status==='loading'} disabled={disabled||values.audioMuted||values.noiseVolume===0} onClick={()=>{if(previewActive)void stopNoise();else void playNoise(undefined,true);}}>{audio.status==='loading'&&audio.preview?<LoaderCircle className="audio-loading"/>:previewActive?<Pause/>:<Play/>}{t(previewActive?'停止试听':'试听 8 秒')}</Button>
    </div>
    {(audio.status==='blocked'||audio.status==='unavailable')&&<p className="audio-status" role="status">{t(audio.status==='blocked'?'点击播放，开启环境音。':'音频暂不可用，请检查系统音频设备。')}</p>}
  </section>;
}
