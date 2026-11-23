import { onBeforeUnmount, shallowRef } from 'vue'

export interface ConfirmationOptions {
  title: string
  message: string
  phrase?: string
  danger?: boolean
  confirmLabel?: string
}

export function useConfirmation() {
  const confirmation = shallowRef<ConfirmationOptions | null>(null)
  let resolvePending: ((accepted: boolean) => void) | undefined
  function answer(accepted: boolean) {
    const resolve = resolvePending
    resolvePending = undefined
    confirmation.value = null
    resolve?.(accepted)
  }
  function confirm(options: ConfirmationOptions): Promise<boolean> {
    answer(false)
    confirmation.value = options
    return new Promise(resolve => { resolvePending = resolve })
  }
  onBeforeUnmount(() => answer(false))
  return { confirmation, confirm, answer }
}
