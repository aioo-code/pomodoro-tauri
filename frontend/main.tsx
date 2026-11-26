import { createRoot } from 'react-dom/client';
import '@/lib/theme';
import '@/style.css';
document.addEventListener('selectstart', event => { if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault(); });
document.addEventListener('dragstart', event => event.preventDefault());
document.addEventListener('contextmenu', event => { if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault(); });
const load = window.location.pathname.endsWith('reminder.html') ? import('@/Reminder') : import('@/App');
load.then(({ default: View }) => createRoot(document.getElementById('root')!).render(<View/>));
