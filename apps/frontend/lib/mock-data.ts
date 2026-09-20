import type { TaskPriority } from "@pf/rxdb-collections"
import type { TaskStatus } from "./todo-types"

type FormComplexity = "Simple" | "Medium" | "Complex"

export interface Task {
  id: string
  processName: string
  stepName: string
  role: string
  status: TaskStatus
  priority: TaskPriority
  assignedDate: string
  dueDate?: string
  upcomingIn?: string
  draftSavedAt?: string
  overdueBy?: string
  formComplexity: FormComplexity
  description: string
}

export const tasks: Task[] = [
  {
    id: "task-1",
    processName: "Employee Onboarding",
    stepName: "Complete tax withholding form",
    role: "Employee",
    status: "Active",
    priority: "High",
    assignedDate: "Today",
    dueDate: "Due in 4 hours",
    formComplexity: "Medium",
    description: "Provide payroll details for finance",
  },
  {
    id: "task-2",
    processName: "Purchase Request",
    stepName: "Review purchase request #1234",
    role: "Manager",
    status: "Active",
    priority: "Medium",
    assignedDate: "Yesterday",
    dueDate: "Due tomorrow",
    formComplexity: "Simple",
    description: "Approve purchase of monitors for design team",
  },
  {
    id: "task-3",
    processName: "Custom Project Kickoff",
    stepName: "Provide project requirements",
    role: "Product Owner",
    status: "Draft",
    priority: "Medium",
    assignedDate: "Sep 18",
    draftSavedAt: "Autosaved 2 minutes ago",
    formComplexity: "Complex",
    description: "Complete the discovery brief for project velocity",
  },
  {
    id: "task-4",
    processName: "Time Off Request",
    stepName: "Acknowledge time off approval",
    role: "Employee",
    status: "Upcoming",
    priority: "Low",
    assignedDate: "Scheduled",
    upcomingIn: "Expected in 2 days",
    formComplexity: "Simple",
    description: "Confirm receipt of approved time off",
  },
  {
    id: "task-5",
    processName: "Bug Report and Fix",
    stepName: "Provide QA notes for bug #555",
    role: "QA Analyst",
    status: "Overdue",
    priority: "High",
    assignedDate: "Assigned 3 days ago",
    overdueBy: "Overdue by 18 hours",
    formComplexity: "Medium",
    description: "Attach reproduction steps and verification checklist",
  },
]

type ExecutionStatus = "Running" | "Paused" | "Completed" | "Failed"

interface ExecutionParticipant {
  id: string
  name: string
  role: string
}

interface ExecutionStep {
  id: string
  name: string
  status: "Complete" | "Current" | "Upcoming" | "Skipped"
  role: string
  startedAt?: string
  completedAt?: string
  assignee?: string
  notes?: string
}

export interface Execution {
  id: string
  processName: string
  executionId: string
  status: ExecutionStatus
  progress: string
  startDate: string
  lastActivity: string
  completionDate?: string
  completionIso?: string
  currentStep?: string
  currentRole?: string
  participants: ExecutionParticipant[]
  steps: ExecutionStep[]
  failureReason?: string
  abandonedReason?: string
  cycleTimeHours?: number
  slaTargetHours?: number
  slaBreached?: boolean
}

export const executions: Execution[] = [
  {
    id: "execution-4521",
    processName: "Employee Onboarding",
    executionId: "#4521",
    status: "Running",
    progress: "Step 2 of 4",
    startDate: "Started 2 days ago",
    lastActivity: "Updated 1 hour ago",
    currentStep: "IT account setup",
    currentRole: "IT Operations",
    cycleTimeHours: 42,
    slaTargetHours: 96,
    slaBreached: false,
    participants: [
      { id: "participant-1", name: "Anna Lee", role: "Employee" },
      { id: "participant-2", name: "Jordan Smith", role: "HR" },
      { id: "participant-3", name: "Miguel Perez", role: "IT Ops" },
    ],
    steps: [
      {
        id: "step-1",
        name: "Collect personal info",
        status: "Complete",
        role: "Employee",
        startedAt: "Oct 8, 09:00",
        completedAt: "Oct 8, 10:15",
        assignee: "Anna Lee",
      },
      {
        id: "step-2",
        name: "IT account setup",
        status: "Current",
        role: "IT Operations",
        startedAt: "Oct 8, 10:30",
        assignee: "Miguel Perez",
        notes: "Waiting for hardware confirmation",
      },
      {
        id: "step-3",
        name: "Benefits enrollment",
        status: "Upcoming",
        role: "Employee",
      },
      {
        id: "step-4",
        name: "Manager review",
        status: "Upcoming",
        role: "Manager",
      },
    ],
  },
  {
    id: "execution-1234",
    processName: "Purchase Request",
    executionId: "#1234",
    status: "Running",
    progress: "Step 3 of 4",
    startDate: "Started 1 week ago",
    lastActivity: "Updated 2 hours ago",
    currentStep: "Finance approval",
    currentRole: "Finance",
    cycleTimeHours: 120,
    slaTargetHours: 144,
    slaBreached: false,
    participants: [
      { id: "participant-4", name: "Noah Patel", role: "Requester" },
      { id: "participant-5", name: "Ava Brooks", role: "Manager" },
      { id: "participant-6", name: "Liam Chen", role: "Finance" },
    ],
    steps: [
      {
        id: "step-a",
        name: "Submit request",
        status: "Complete",
        role: "Requester",
        startedAt: "Oct 1, 11:20",
        completedAt: "Oct 1, 11:32",
        assignee: "Noah Patel",
      },
      {
        id: "step-b",
        name: "Manager approval",
        status: "Complete",
        role: "Manager",
        startedAt: "Oct 1, 11:45",
        completedAt: "Oct 2, 09:10",
        assignee: "Ava Brooks",
      },
      {
        id: "step-c",
        name: "Finance approval",
        status: "Current",
        role: "Finance",
        startedAt: "Oct 3, 08:05",
        assignee: "Liam Chen",
      },
      {
        id: "step-d",
        name: "Procurement",
        status: "Upcoming",
        role: "Procurement",
      },
    ],
  },
  {
    id: "execution-8832",
    processName: "Time Off Request",
    executionId: "#8832",
    status: "Completed",
    progress: "Finished",
    startDate: "Started Oct 10",
    lastActivity: "Completed yesterday",
    completionDate: "Completed Oct 12",
    completionIso: "2024-10-12T15:30:00Z",
    cycleTimeHours: 36,
    slaTargetHours: 48,
    slaBreached: false,
    participants: [
      { id: "participant-7", name: "Emma Davis", role: "Employee" },
      { id: "participant-8", name: "Reese Morgan", role: "Manager" },
    ],
    steps: [
      {
        id: "step-e",
        name: "Submit request",
        status: "Complete",
        role: "Employee",
        startedAt: "Oct 10, 14:10",
        completedAt: "Oct 10, 14:20",
        assignee: "Emma Davis",
      },
      {
        id: "step-f",
        name: "Manager approval",
        status: "Complete",
        role: "Manager",
        startedAt: "Oct 10, 15:00",
        completedAt: "Oct 11, 09:42",
        assignee: "Reese Morgan",
      },
      {
        id: "step-g",
        name: "HR notification",
        status: "Complete",
        role: "HR",
        startedAt: "Oct 11, 10:05",
        completedAt: "Oct 12, 11:30",
        assignee: "HR Automation",
      },
    ],
  },
  {
    id: "execution-555",
    processName: "Bug Report and Fix",
    executionId: "#555",
    status: "Failed",
    progress: "Step 5 of 6",
    startDate: "Started Sep 30",
    lastActivity: "Failed at QA step",
    currentStep: "QA test",
    currentRole: "QA",
    failureReason: "Automated regression suite failed on pipeline",
    completionIso: "2024-10-11T11:00:00Z",
    cycleTimeHours: 210,
    slaTargetHours: 168,
    slaBreached: true,
    participants: [
      { id: "participant-9", name: "Caleb Finch", role: "Reporter" },
      { id: "participant-10", name: "Ivy Nguyen", role: "Developer" },
      { id: "participant-11", name: "Priya Desai", role: "QA" },
    ],
    steps: [
      {
        id: "step-h",
        name: "Report bug",
        status: "Complete",
        role: "Reporter",
        startedAt: "Sep 30, 08:20",
        completedAt: "Sep 30, 08:33",
        assignee: "Caleb Finch",
      },
      {
        id: "step-i",
        name: "Triage",
        status: "Complete",
        role: "Triage Team",
        startedAt: "Sep 30, 09:00",
        completedAt: "Sep 30, 12:05",
        assignee: "Ops Bot",
      },
      {
        id: "step-j",
        name: "Assign developer",
        status: "Complete",
        role: "Engineering Lead",
        startedAt: "Sep 30, 12:10",
        completedAt: "Sep 30, 12:45",
        assignee: "Ivy Nguyen",
      },
      {
        id: "step-k",
        name: "Fix",
        status: "Complete",
        role: "Developer",
        startedAt: "Oct 1, 09:05",
        completedAt: "Oct 2, 16:20",
        assignee: "Ivy Nguyen",
      },
      {
        id: "step-l",
        name: "QA test",
        status: "Current",
        role: "QA",
        startedAt: "Oct 3, 10:00",
        assignee: "Priya Desai",
        notes: "Regression suite failure on payment gateway",
      },
      {
        id: "step-m",
        name: "Deploy",
        status: "Upcoming",
        role: "Release Manager",
      },
    ],
  },
]

export interface TrendPoint {
  label: string
  completed: number
  failed: number
  slaBreachRate: number
}

export interface SlaBucket {
  label: string
  percentage: number
  tone: "good" | "warn" | "bad"
}
