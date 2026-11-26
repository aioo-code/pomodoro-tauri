import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, env } from './environment.mjs';
const read=file=>JSON.parse(readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const releaseSource = process.env.POMODORO_RELEASE_SOURCE;
const latest = releaseSource
  ? { output: path.resolve(releaseSource), version: read(path.join(path.resolve(releaseSource), 'delivery.json')).version }
  : read(path.join(root, 'artifacts/settings-latest.json'));
const source=read(path.join(latest.output,'delivery.json'));
assert.equal(source.acceptance,'passed');assert.equal(source.version,latest.version);
const sourceExe=path.join(latest.output,'pomodoro-connected.exe');assert.equal(hash(sourceExe),source.sha256);
const stage=path.join(root,'tmp/installer-stage',source.version),target=path.join(stage,'target');
const output=path.join(root,'artifacts/installers',source.version);mkdirSync(output,{recursive:true});mkdirSync(path.join(target,'release'),{recursive:true});
cpSync(sourceExe,path.join(target,'release/pomodoro-connected.exe'));
const existingTools=path.join(root,'src-tauri/target/.tauri');if(existsSync(existingTools)&&!existsSync(path.join(target,'.tauri')))cpSync(existingTools,path.join(target,'.tauri'),{recursive:true});
const resources={};
for(const [from,to] of [['scripts','scripts'],['licenses','licenses'],['icons','icons']])resources[path.join(latest.output,from).replaceAll('\\','/')]=to;
const shortcutIcon=path.join(stage,`pomodoro-app-icon-${source.version}.ico`);cpSync(path.join(latest.output,'icons/flow.ico'),shortcutIcon);
resources[shortcutIcon.replaceAll('\\','/')]=path.basename(shortcutIcon);
resources[path.join(root,'frontend/components/ui/LICENSE.md').replaceAll('\\','/')]='licenses/shadcn-ui.md';
const wrapper=path.join(stage,'update-hooks.nsh');
writeFileSync(wrapper,`!define POMODORO_ICON_VERSION "${source.version}"\n!define POMODORO_UPDATE_BINARY "${path.join(target,'release/pomodoro-connected.exe')}"\n!include "${path.join(root,'packaging/windows/install-hooks.nsh')}"\n`);
const config={version:source.version,mainBinaryName:'pomodoro-connected',bundle:{active:true,targets:['nsis'],useLocalToolsDir:true,icon:['icons/icon.ico'],shortDescription:'专注、休息与轻量悬浮计时',resources,windows:{allowDowngrades:false,webviewInstallMode:{type:'embedBootstrapper',silent:true},nsis:{installMode:'currentUser',languages:['SimpChinese'],displayLanguageSelector:false,compression:'lzma',installerIcon:'icons/icon.ico',uninstallerIcon:'icons/icon.ico',installerHooks:wrapper}}}};
const configFile=path.join(stage,'installer.config.json');writeFileSync(configFile,JSON.stringify(config,null,2));
console.log('Bundling the exact accepted executable: '+source.version);
const child=spawn(process.execPath,[path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),'bundle','--bundles','nsis','--config',configFile,'--ci','--no-sign','--no-binary-patching'],{cwd:root,env:{...env,CARGO_TARGET_DIR:target},stdio:'inherit',windowsHide:true});
const [code]=await once(child,'exit');assert.equal(code,0,'installer bundling failed');
assert.equal(hash(path.join(target,'release/pomodoro-connected.exe')),source.sha256,'bundler changed the verified executable');
const nsis=path.join(target,'release/bundle/nsis');
const installers=readdirSync(nsis).filter(file=>file.endsWith('-setup.exe'));assert.equal(installers.length,1);
const installer=path.join(output,`pomodoro-tauri-${source.version}-windows-x64-setup.exe`);cpSync(path.join(nsis,installers[0]),installer);
cpSync(configFile,path.join(output,'installer.config.json'));cpSync(path.join(root,'packaging/windows/install-hooks.nsh'),path.join(output,'install-hooks.nsh'));
const receipt={at:new Date().toISOString(),version:source.version,installer,sha256:hash(installer),bytes:statSync(installer).size,programSha256:source.sha256,programVersion:source.productVersion,acceptedProgram:sourceExe,method:'Tauri NSIS bundle only; binary patching disabled; reuses the accepted program without relabeling',installMode:'currentUser',language:'SimpChinese',webview:'embedded bootstrapper; downloads runtime only if missing',signed:false,stage,target,validation:'pending'};
writeFileSync(path.join(output,'installer.json'),JSON.stringify(receipt,null,2));
writeFileSync(path.join(root,'tmp/installer-current.json'),JSON.stringify(receipt,null,2));
writeFileSync(path.join(output,'SHA256SUMS.txt'),`${receipt.sha256}  ${path.basename(installer)}\n`);
writeFileSync(path.join(output,'安装说明.txt'),[
  `番茄时钟 ${source.version}`,
  '已在 Windows 11 x64 上验收。此安装包未签名。',
  ...(source.checks?.miniFooterSwitch ? ['小窗底部文案：悬停或聚焦按钮时显示按钮提示，关闭提示后恢复格致语录或计时状态。异常和待同步提醒优先。'] : []),
  ...(source.checks?.originalAudioAndCalmReminder ? [
    '原创轻柔交互音效；冥想氛围提供静心、空灵、颂钵三种离线音色。声音设置采用统一卡片，可独立开关、调节音量和试听。主窗标题栏提供静音模式按钮，保留原音量和独立开关。',
    '到时提醒重新设计为平和留白布局，弱化主题光环与大色块；环境音渐入，可暂停、切换质感、静音，关闭提醒即停止。',
  ] : []),
  '覆盖安装时可确认关闭已运行的番茄时钟；当前计时会结束，设置和本地使用记录保留。未能正常关闭时会停止覆盖，不强制结束进程。',
  ...(source.checks?.popupContainmentAndTransitions ? ['小窗提示改为窗内提示槽，兼容五种语言，错误/记录状态优先，避免上沿裁切和文字重叠；修正主窗样式内边距影响小窗数字的问题。提醒长文恢复触控和鼠标滚动，关闭按钮保持可达。', '计时采用 React Bits StatusMark 光环和 SloshGauge 液态方案，连接真实剩余进度；细化刻度和数字排版。默认流光图标细化轮廓、渐变、留白和指针，并同步所有图标资源；标题栏显示当前应用图标，与任务栏、托盘一致。设置/计时样式使用 View Transition，大小窗协调内容淡出淡入，减少动效时简化。'] : []),
  ...(source.checks?.timerViewsAndCustomColor ? [source.checks?.popupContainmentAndTransitions?'设置页返回位于标题栏；主题色提供单行预设与自定义色盘，五种计时样式保留拖动调整；主窗按钮悬停和按住保持位置和尺寸。':'设置页返回移到右侧标题栏，释放正文高度；五个常用主题色与自定义色盘保持单行。主窗左右切换彗星、静弧、环绕、刻度、字面五种计时样式，可继续拖动调整剩余时间。悬停和按住主窗按钮时保持位置和尺寸，仅保留光影反馈。'] : []),
  ...(source.checks?.customMeditationAudio ? ['冥想环境音支持导入本机音频、命名、试听和移除；单文件上限 100 MB，保存应用内副本，不改动原文件。提醒窗沿用所选声音并随关闭停止。'] : []),
  ...(source.checks?.settingsScrollFeather ? ['设置页滚动内容与模糊一起渐隐，消除上下硬切和亮雾带；滚动条保持清晰，到顶/到底时首尾控件完整显示。'] : []),
  ...(source.checks?.windowSurfaceInspection ? ['整窗 Spotlight 聚光，取消计时区内框；按钮使用参照的渐变、内侧高光与深浅落影，正文和热力图边距统一。外窗保留 Windows 原生圆角档位，控件继续支持精细圆角调节。'] : source.checks?.primaryButtonAndGlass ? ['主窗使用透明 Spotlight 卡片与 Chroma 按钮聚光；设置页上下渐进模糊；新增墨黑、月白；提醒窗留白重新平衡、音量线两端约 26px 边距；拖动大小窗保留原生磨砂模糊。'] : []),
  ...(source.checks?.elasticVolumeAndMiniAcrylic ? ['音量使用弹性滑条反馈，保留触摸、键盘和自动保存。小窗保留原生亚克力；磨砂开启时淡化内容与表面色调，关闭时保留整窗透明。'] : []),
  ...(source.checks?.prepareUpdate ? ['触屏拖动的实机跟手问题尚未解决，本版保留现有触屏方案。'] : []),
  ...(source.checks?.personalMaxims ? ['设置页新增“格致语录”：支持添加、编辑、删除和关闭自律格言；语录仅保存在本机。主窗状态位置和小窗底部共享当前语录，每段计时换一句，暂停/继续及大小窗切换不换句。没有语录时恢复真实计时状态，小窗异常与待同步提醒优先显示；恢复显示默认设置保留自定义语录。'] : []),
  '缺少 WebView2 运行时时，安装器会联网下载。请允许其完成后再启动。',
  ...(source.checks?.dragAndDailyUsage ? [
    '鼠标拖拽改为 Windows 原生移动；触摸发送最新位置，避免旧位置积压。松手后保留屏幕贴边边距。',
    '主窗底部显示近 30 天使用热力图，按每天完成专注的次数着色；悬停或键盘左右移动可查看日期与次数。',
    '使用记录仅保存在本机，从本版开始累计；暂停、休息或重复关闭提醒不会增加次数。',
  ] : []),
  '已修正不支持 Win11 圆角及磨砂属性时启动中止的问题；不支持磨砂的设备自动使用主题实色背景。',
  '已修正管理员账户默认目录所有者与用户 SID 不一致导致启动失败的问题。旧版留下的组所有空目录会保留备份，再创建正确归属的私有目录；无需手动改权限。',
  '已完成不支持窗口特效的模拟回归与 Win11 程序运行检查；尚未进行 Win10 实机安装验收。',
  '如果仍启动失败，请提供错误提示；错误记录位于 %LOCALAPPDATA%/local.cosweel.pomodoro/startup-error.log。',
  '升级保留用户目录。安装器不包含个人设置。',
  `SHA256：${receipt.sha256}`,
].join('\r\n')+'\r\n');
console.log(JSON.stringify({installer,sha256:receipt.sha256,bytes:receipt.bytes}));
