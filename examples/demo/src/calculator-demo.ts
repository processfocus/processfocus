import { AwsFunctionStep } from "@processfocus/plugin-aws-lambda"
import { Schema as ES, Effect } from "effect"
import { Form, type OrgUnit, Process, type Role, Sla } from "@pf/process"
import { enterNumbersForm, showResultForm } from "./calculator-demo-forms"

type CalculatorInputState = {
  readonly a: number
  readonly b: number
}

export class CalculatorDemo extends Process {
  constructor(scope: OrgUnit, id: string, employeeRole: Role) {
    super(scope, id, {
      name: "Calculator Demo",
      purpose:
        "Demonstrates AWS Lambda function integration by adding two numbers",
      sla: Sla.minutes(5),
    })

    // Step 1: User inputs two numbers
    const input_numbers = new Form(this, "Enter numbers", {
      name: "Enter two numbers",
      embed: {
        externalParticipantEmailField: "email",
        sites: ["http://localhost:3000", "http://127.0.0.1:3000"],
        thankYou:
          "Thanks. Your calculation request has been submitted without signing in.",
      },
      form: enterNumbersForm,
      browser: {
        entrypoint: "src/calculator-demo-forms.ts",
        exportName: "enterNumbersForm",
      },
      role: employeeRole,
    })

    const flow = this.start(input_numbers)

    // Step 2: AWS Lambda function adds the numbers
    const add_numbers = new AwsFunctionStep(flow, "Add numbers", {
      name: "Calculate sum via AWS Lambda",
      functionName: "demo-add-numbers",
      input: (state: CalculatorInputState) =>
        Effect.succeed({ a: state.a, b: state.b }),
      output: { result: ES.Number },
    })

    const flow2 = flow.next(add_numbers)

    // Step 3: Show the result
    const show_result = new Form(flow2, "Show result", {
      name: "Calculation result",
      form: showResultForm,
      browser: {
        entrypoint: "src/calculator-demo-forms.ts",
        exportName: "showResultForm",
      },
      bindings: (state) => ({
        firstNumber: { default: String(state.a) },
        secondNumber: { default: String(state.b) },
        sum: { default: String(state.result) },
      }),
      summary: (state) => ({
        Calculation: `${state.a} + ${state.b} = ${state.result}`,
      }),
      role: employeeRole,
    })

    flow2.end(show_result)
  }
}
