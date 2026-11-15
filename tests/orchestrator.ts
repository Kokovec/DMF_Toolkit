// Where the DMF_Orchestrator checkout is, for the tests that compare against it (its schema and its
// facility export). Set DMF_ORCHESTRATOR to your checkout; the default is where it lives on the
// development machine (WSL distro Ubuntu-24.04, seen from this distro). Not a test file itself.
import { userInfo } from 'node:os'

export const ORCHESTRATOR =
  process.env.DMF_ORCHESTRATOR ?? `/mnt/wsl/instances/Ubuntu-24.04/home/${userInfo().username}/DMF_Orchestrator`
