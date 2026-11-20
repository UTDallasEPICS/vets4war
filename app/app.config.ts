// Nuxt UI in the console's shapes: pill buttons, grey tiles without borders, soft
// rounded fields. The colours themselves are CSS variables in assets/css/main.css.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'neutral',
    },
    button: {
      slots: {
        base: 'rounded-full font-medium',
      },
    },
    card: {
      slots: {
        root: 'rounded-[18px]',
        header: 'px-6 pt-6 pb-0 sm:px-6',
        body: 'p-6 sm:p-6',
        footer: 'px-6 pb-6 pt-0 sm:px-6',
      },
      variants: {
        variant: {
          outline: { root: 'bg-elevated ring-0 divide-y-0' },
        },
      },
    },
    badge: {
      slots: {
        base: 'rounded-full font-medium',
      },
    },
    alert: {
      slots: {
        root: 'rounded-xl',
        title: 'font-medium',
      },
    },
    input: {
      slots: {
        base: 'rounded-[9px]',
      },
    },
    select: {
      slots: {
        base: 'rounded-[9px]',
      },
    },
    modal: {
      slots: {
        content: 'rounded-[18px] ring-0',
      },
    },
  },
})
