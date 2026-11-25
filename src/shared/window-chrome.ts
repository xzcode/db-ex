/** Keep native and renderer window chrome in agreement. Never infer from UA. */
export type WindowChrome = 'native' | 'mac-native-controls'
export function windowChromeForPlatform(platform:string):WindowChrome {
  return platform==='darwin'?'mac-native-controls':'native'
}
export const macTrafficLightPosition={x:16,y:22} as const
export function windowChromeOptions(platform:string){
  return windowChromeForPlatform(platform)==='mac-native-controls'
    ? {titleBarStyle:'hidden' as const,trafficLightPosition:{...macTrafficLightPosition}}
    : {}
}
