import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

// Trusted platform hint from the sandboxed preload; browser tests use native by default.
document.documentElement.dataset.windowChrome=window.dbex?.windowChrome==='mac-native-controls'?'mac-native-controls':'native'
createApp(App).mount('#app')
