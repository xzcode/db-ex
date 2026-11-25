import test from 'node:test'
import assert from 'node:assert/strict'
import {windowChromeForPlatform,windowChromeOptions,macTrafficLightPosition} from '../src/shared/window-chrome'
test('only macOS uses hidden title bar with native traffic light positions',()=>{
 assert.equal(windowChromeForPlatform('darwin'),'mac-native-controls')
 assert.deepEqual(windowChromeOptions('darwin'),{titleBarStyle:'hidden',trafficLightPosition:macTrafficLightPosition})
 for(const platform of ['win32','linux','freebsd']){
   assert.equal(windowChromeForPlatform(platform),'native')
   assert.deepEqual(windowChromeOptions(platform),{})
 }
})
