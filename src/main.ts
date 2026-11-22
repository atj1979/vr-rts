import './style.css';
import { boot } from './game.ts';

const root = document.querySelector('#app');
if (!root) throw new Error('Missing #app');
void boot(root as HTMLElement);
