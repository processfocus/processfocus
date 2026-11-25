---------------------------- MODULE Supervised ----------------------------
EXTENDS Terminal

(* #3670: the supervisor's clock runs outside the execution process. "hung"
   includes synchronous thread blocking, uninterruptible work and stuck cleanup.
   The hard bound includes the cooperative controller's I/O/grace envelope.
   Killing/reaping the isolated worker precedes restart; no old actor survives.
   Persistent claims, budgets and terminal evidence are NOT reset by restart.
   Assumptions: bounded host kill/reap and startup, responsive supervisor clock,
   eventual DB availability and unpause. RestartTicks abstracts that OS/startup
   bound. We assume aggregate worker/maintenance fairness, not fair job choice. *)
CONSTANT RestartTicks
ASSUME RestartTicks \in Nat \ {0}
VARIABLES restarting, startupSweep
svars == <<tvars, restarting, startupSweep>>
HardBound == ExecutionTicks + GraceTicks
SInit == TInit /\ restarting = 0 /\ startupSweep = TRUE
SSelect == /\ restarting = 0 /\ ~startupSweep /\ TSelect /\ UNCHANGED <<restarting, startupSweep>>
SClaim == /\ restarting = 0 /\ ~startupSweep /\ TClaim /\ UNCHANGED <<restarting, startupSweep>>
SHandle == /\ restarting = 0 /\ THandle /\ UNCHANGED <<restarting, startupSweep>>
SFinish == /\ restarting = 0 /\ TFinish /\ UNCHANGED <<restarting, startupSweep>>
SRenew == /\ restarting = 0 /\ phase # "hung" /\ TRenew
          /\ UNCHANGED <<restarting, startupSweep>>
(* #3671: parent-side maintenance no longer depends on child execution/startup. *)
SMaintain == /\ Maintain
             /\ UNCHANGED <<restarting, startupSweep>>
SStartup == /\ restarting = 0 /\ startupSweep
            /\ IF Recoverable # {} THEN Maintain ELSE UNCHANGED tvars
            /\ startupSweep' = FALSE /\ UNCHANGED restarting
SRefill == TRefill /\ UNCHANGED <<restarting, startupSweep>>

STick ==
    /\ delay' = [j \in Jobs |-> IF delay[j] > 0 THEN delay[j] - 1 ELSE 0]
    /\ lease' = [j \in Jobs |-> IF lease[j] > 0 THEN lease[j] - 1 ELSE 0]
    /\ clock' = 1 - clock
    /\ UNCHANGED <<rows, attempts, selected, done, failed, evidence>>
    /\ IF active = 0
       THEN /\ restarting' = IF restarting > 0 THEN restarting - 1 ELSE 0
            /\ UNCHANGED <<active, phase, deadline, cleanup, owned, occupation, startupSweep>>
       ELSE IF occupation = HardBound - 1
       THEN (* Forced abandonment, not a business/handler failure. *)
            /\ active' = 0 /\ phase' = "idle" /\ owned' = FALSE
            /\ deadline' = 0 /\ cleanup' = 0 /\ occupation' = 0
            /\ restarting' = RestartTicks
            /\ startupSweep' = TRUE
       ELSE /\ occupation' = occupation + 1
            /\ deadline' = IF deadline > 0 THEN deadline - 1 ELSE 0
            /\ owned' = (owned /\ deadline > 1 /\ lease[active] > 1)
            /\ UNCHANGED <<active, phase, cleanup, restarting, startupSweep>>

SNext == SSelect \/ SClaim \/ SHandle \/ SFinish \/ SRenew
         \/ SMaintain \/ SRefill \/ STick \/ SStartup
SSpec == SInit /\ [][SNext]_svars
         /\ WF_svars(SSelect) /\ WF_svars(SClaim) /\ WF_svars(SHandle)
         /\ WF_svars(SFinish) /\ WF_svars(STick) /\ WF_svars(SMaintain)
         /\ WF_svars(SRefill)
         /\ WF_svars(SStartup)
SupervisedTypeOK == TerminalTypeOK /\ restarting \in 0..RestartTicks
                    /\ startupSweep \in BOOLEAN
BoundedCapacity == /\ occupation < HardBound
                   /\ (restarting > 0 => active = 0 /\ ~owned)
CapacityRecovered == [](active # 0 => <>(active = 0 /\ restarting = 0))
=============================================================================
