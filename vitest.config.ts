import { meshworkVitest } from '@meshwork-ai/config/vitest'

export default meshworkVitest({ include: ['plugin/test/**/*.test.ts'], testTimeout: 20_000 })
