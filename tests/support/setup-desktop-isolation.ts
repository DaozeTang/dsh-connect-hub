/**
 * Global test isolation for the Qoder desktop-sign-in reader.
 *
 * The reader normally looks in the developer's own Qoder app data. Tests must
 * never read that file (or the OS keychain behind it), so both region overrides
 * point at paths that cannot exist for the whole test process. Tests that want
 * a desktop sign-in inject their own reader through `QoderRuntimeOverrides`.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['DSH_CONNECT_HUB_QODER_CN_AUTH_FILE'] = join(tmpdir(), 'dsh-connect-hub-tests-no-qoder-cn-auth.v1.dat')
process.env['DSH_CONNECT_HUB_QODER_GLOBAL_AUTH_FILE'] = join(tmpdir(), 'dsh-connect-hub-tests-no-qoder-global-auth.v1.dat')
