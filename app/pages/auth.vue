<script setup lang="ts">
  import { z } from 'zod'
  import { authClient } from '../utils/auth-client'

  // Sign-up is off: an address nobody added gets no mail and no error, so the page
  // never says whether an address has access.
  const CODE_HINT = 'If that address has access, a code is on its way.'

  const toast = useToast()
  const isEmailSent = ref(false)

  const schema = computed(() => {
    if (!isEmailSent.value) {
      return z.object({
        email: z.string().email('Invalid email'),
      })
    } else {
      return z.object({
        email: z.string().email('Invalid email'),
        otp: z.array(z.string()).length(6, 'Must be 6 digits'),
      })
    }
  })

  const state = reactive({
    email: '',
    otp: [] as string[],
  })

  async function handleSubmit() {
    if (!isEmailSent.value) {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: state.email,
        type: 'sign-in',
      })

      if (error) {
        toast.add({ title: 'Error', description: error.message, color: 'error' })
      } else {
        isEmailSent.value = true
      }
    } else {
      const { error } = await authClient.signIn.emailOtp({
        email: state.email,
        otp: state.otp.join(''),
      })

      if (error) {
        toast.add({ title: 'Error', description: error.message, color: 'error' })
      } else {
        await navigateTo('/', { external: true })
      }
    }
  }
</script>

<template>
  <div class="flex h-full w-full items-center justify-center py-12">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="flex items-center justify-center text-xl font-bold">Sign in</h1>
      </template>

      <UForm :schema="schema" :state="state" @submit="handleSubmit" class="space-y-5">
        <UFormField name="email" v-if="!isEmailSent">
          <UInput v-model="state.email" class="w-full" placeholder="Email" type="email" />
        </UFormField>

        <template v-if="isEmailSent">
          <p class="text-center text-sm text-gray-600 dark:text-gray-300" data-testid="code-hint">
            {{ CODE_HINT }}
          </p>
          <UFormField name="otp">
            <UPinInput
              otp
              v-model="state.otp"
              :length="6"
              size="xl"
              class="flex w-full items-center justify-center"
            />
          </UFormField>
        </template>

        <UButton loading-auto type="submit" class="w-full justify-center">
          {{ isEmailSent ? 'Sign in' : 'Send code' }}
        </UButton>
      </UForm>
    </UCard>
  </div>
</template>
