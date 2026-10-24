import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const files=['workspace-navigation.css','my-work-shell.css','dashboard-widgets.css'];
const css=files.map(file=>fs.readFileSync('apps/web/src/'+file,'utf8')).join('\n');
const browser=await chromium.launch({headless:true});
const rows=[];
try {
 for(const dashboard of [false,true]) for(const collapsed of [false,true]) {
  const page=await browser.newPage();
  await page.setContent(`<style>${css}</style><div class="app-shell"><div class="workspace-layout workspace-layout--studio"><aside class="workspace-sidebar ${collapsed?'is-collapsed':''}">Desktop navigation</aside><main class="workspace-page"><section class="${dashboard?'dashboard-workspace':'my-work-workspace'}">Page</section></main><div class="workspace-mobile-nav"><nav class="workspace-mobile-main"><a href="#home">Home</a><a href="#work">My Work</a><a href="#projects">Projects</a><a href="#decisions">Decisions</a></nav><button>More</button></div></div></div>`);
  for(const width of [320,390,767,768,783,1024,1440]) {
   await page.setViewportSize({width,height:884});
   const actual=await page.evaluate(()=>({mobile:getComputedStyle(document.querySelector('.workspace-mobile-nav')).display,sidebar:getComputedStyle(document.querySelector('.workspace-sidebar')).display}));
   rows.push({dashboard,collapsed,width,...actual});
  }
  await page.close();
 }
} finally {await browser.close();}
const failures=rows.filter(r=>(r.mobile!=='none')!==(r.width<768)||(r.sidebar!=='none')!==(r.width>=768));
console.log(JSON.stringify({cases:rows.length,failures}));
assert.equal(failures.length,0,'Only the navigation for the active viewport may be displayed');
