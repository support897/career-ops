import { LambdaClient, AddPermissionCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({ region: "us-east-1" });

try {
  const result = await client.send(new AddPermissionCommand({
    FunctionName: "careerflow-scanner",
    StatementId: "AllowPublicFunctionUrl",
    Action: "lambda:InvokeFunctionUrl",
    Principal: "*",
    SourceArn: "arn:aws:lambda:us-east-1:357542024881:function:careerflow-scanner:function-url",
    Condition: {
      StringEquals: {
        "lambda:FunctionUrlAuthType": ["NONE"]
      }
    }
  }));
  console.log("Success:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("Error:", err.name, err.message);
  // Try without condition
  try {
    const result2 = await client.send(new AddPermissionCommand({
      FunctionName: "careerflow-scanner",
      StatementId: "AllowPublicFunctionUrl2",
      Action: "lambda:InvokeFunctionUrl",
      Principal: "*",
      SourceArn: "arn:aws:lambda:us-east-1:357542024881:function:careerflow-scanner:function-url"
    }));
    console.log("Success without condition:", JSON.stringify(result2, null, 2));
  } catch (err2) {
    console.error("Error without condition:", err2.name, err2.message);
  }
}
