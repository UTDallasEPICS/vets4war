<script setup lang="ts">
  import { z } from 'zod'
  import { authClient } from '../utils/auth-client'

  // Sign-up is off: an address nobody added gets no mail and no error, so the page
  // never says whether an address has access.
  const CODE_HINT = 'If that address has access, a code is on its way.'

  // The ink panel draws a day hour by hour in the shape of the brand mark, under the
  // three shifts the staffing page plans. An illustration of the page's subject, not
  // data: it is the same on every visit.
  const DAY_SHAPE = [
    0.3, 0.24, 0.2, 0.17, 0.16, 0.18, 0.26, 0.38, 0.52, 0.64, 0.72, 0.78, 0.8, 0.82, 0.84, 0.86,
    0.88, 0.9, 0.86, 0.8, 0.72, 0.62, 0.5, 0.4,
  ]
  const SHIFTS = [
    { name: 'Overnight', hours: '00:00 to 08:30', from: 0, to: 8.5 },
    { name: 'Day', hours: '08:00 to 16:30', from: 8, to: 16.5 },
    { name: 'Evening', hours: '16:00 to 00:30', from: 16, to: 24 },
  ]

  const toast = useToast()
  const isEmailSent = ref(false)

  const schema = computed(() => {
    if (!isEmailSent.value) {
      return z.object({
        email: z.string().email('Enter an email address such as name@example.org.'),
      })
    } else {
      return z.object({
        email: z.string().email('Enter an email address such as name@example.org.'),
        otp: z.array(z.string()).length(6, 'Type all six digits of the code.'),
      })
    }
  })

  const state = reactive({
    email: '',
    otp: [] as string[],
  })

  function useAnotherAddress() {
    isEmailSent.value = false
    state.otp = []
  }

  async function handleSubmit() {
    if (!isEmailSent.value) {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: state.email,
        type: 'sign-in',
      })

      if (error) {
        toast.add({ title: 'The code was not sent', description: error.message, color: 'error' })
      } else {
        isEmailSent.value = true
      }
    } else {
      const { error } = await authClient.signIn.emailOtp({
        email: state.email,
        otp: state.otp.join(''),
      })

      if (error) {
        toast.add({ title: 'That code did not work', description: error.message, color: 'error' })
      } else {
        await navigateTo('/', { external: true })
      }
    }
  }
</script>

<template>
  <div
    class="mx-auto grid w-full max-w-[1040px] items-stretch gap-4 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:py-6"
  >
    <section
      class="bg-inverted text-inverted relative hidden flex-col justify-between overflow-hidden rounded-[18px] p-8 md:flex"
      aria-label="What this tool does"
    >
      <div class="max-w-sm space-y-3">
        <p class="text-[26px] leading-[1.1] font-semibold tracking-[-0.03em] [font-stretch:92%]">
          Plan every shift from the forecast.
        </p>
        <p class="text-sm leading-relaxed opacity-70">
          The staffing page turns the call forecast into a roster for each shift, hour by hour, and
          shows where the line is short.
        </p>
      </div>

      <div class="mt-10" aria-hidden="true">
        <svg viewBox="0 0 240 110" class="block h-auto w-full" preserveAspectRatio="none">
          <rect
            v-for="(height, hour) in DAY_SHAPE"
            :key="hour"
            :x="hour * 10 + 2.2"
            :y="100 - height * 100"
            width="5.6"
            :height="height * 100"
            rx="2.8"
            fill="currentColor"
            :opacity="0.28 + height * 0.72"
          />
        </svg>
        <div class="relative mt-3 h-12">
          <div
            v-for="(shift, index) in SHIFTS"
            :key="shift.name"
            class="absolute top-0 flex flex-col gap-0.5 border-t-2 pt-2 text-xs"
            :class="index === 1 ? 'border-current' : 'border-current/40'"
            :style="{
              left: `${(shift.from / 24) * 100}%`,
              width: `calc(${((shift.to - shift.from) / 24) * 100}% - 6px)`,
            }"
          >
            <span class="font-medium">{{ shift.name }}</span>
            <span class="opacity-60">{{ shift.hours }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="bg-elevated flex flex-col justify-center rounded-[18px] p-6 sm:p-10">
      <div class="mx-auto w-full max-w-sm">
        <h1 class="page-title">Sign in</h1>
        <p class="text-muted mt-2 text-sm">
          {{
            isEmailSent
              ? `Type the six-digit code sent to ${state.email}.`
              : 'Use the email address an admin added for you. We send a six-digit code; there is no password.'
          }}
        </p>

        <UForm :schema="schema" :state="state" class="mt-8 space-y-5" @submit="handleSubmit">
          <UFormField v-if="!isEmailSent" name="email" label="Email address">
            <UInput
              v-model="state.email"
              class="w-full"
              size="xl"
              placeholder="name@example.org"
              type="email"
              autocomplete="email"
              autofocus
              :ui="{ base: 'bg-default' }"
            />
          </UFormField>

          <template v-if="isEmailSent">
            <p
              class="text-primary rounded-xl bg-[var(--v4w-accent-soft)] px-4 py-3 text-sm font-medium"
              data-testid="code-hint"
            >
              {{ CODE_HINT }}
            </p>
            <UFormField name="otp" label="Sign-in code">
              <UPinInput
                v-model="state.otp"
                otp
                :length="6"
                size="xl"
                class="flex w-full items-center justify-between"
                :ui="{ base: 'bg-default size-12 text-lg' }"
              />
            </UFormField>
          </template>

          <UButton loading-auto type="submit" size="xl" class="w-full justify-center text-[15px]">
            {{ isEmailSent ? 'Sign in' : 'Send code' }}
          </UButton>
          <UButton
            v-if="isEmailSent"
            type="button"
            color="neutral"
            variant="ghost"
            class="text-muted w-full justify-center text-[13px]"
            @click="useAnotherAddress"
          >
            Use another address
          </UButton>
        </UForm>
      </div>
    </section>
  </div>
</template>
