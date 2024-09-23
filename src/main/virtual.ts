import vm from 'vm';

export function get(variableName: string, context: vm.Context) {
    return vm.runInContext(`${variableName}`, context);
}

export function set(variableName: string, value: any, context: vm.Context) {
    vm.runInContext(`${variableName} = ${value}`, context);
}

function run(code: string, context: vm.Context) {
    vm.runInContext(code, context);
}

// This function will take in a string that will have a $eval keyword at the start of a codeblock and a $halt keyword at the end of the codeblock.
// It will then run the code in between the $eval and $halt keywords.
// It will return the output of the code.
export function evaluate(code: string, context: vm.Context) {
    // throw an error if there is no halt keyword
    if (!code.includes('$halt')) {
        throw new Error('Code block must end with $halt');
    }

    const codeBlock = code.slice(code.indexOf('$eval') + 5, code.indexOf('$halt'));
    run(codeBlock, context);

    // return the code string with the all content between $eval and $halt keywords removed
    return code.slice(0, code.indexOf('$eval')) + code.slice(code.indexOf('$halt') + 6);
}

export function evaluateGet(code: string, context: vm.Context) {
    // there will be a $get keyword in the form $get(variableName), we will take that and run the get function and replace the $get(variableName) with the return value
    const variableName = code.slice(code.indexOf('$get(') + 5, code.indexOf(')'));
    const value = get(variableName, context);
    return code.replace(`$get(${variableName})`, value);
}

export function evaluateSet(code: string, context: vm.Context) {
    // there will be a $set keyword in the form $set(variableName, value), we will take that and run the set function and replace the $set(variableName, value) with nothing
    const variableName = code.slice(code.indexOf('$set(') + 5, code.indexOf(','));
    const value = code.slice(code.indexOf(',') + 1, code.indexOf(')'));
    set(variableName, value, context);
    return code.replace(`$set(${variableName}, ${value})`, '');
}

export function stringInfoAddEval(code: string, context: vm.Context) {
      if (code.includes('$eval')) {
        code = evaluate(code, context);
      }
      if (code.includes('$get')) {
        code = evaluateGet(code, context);
      }
      if (code.includes('$set')) {
        code = evaluateSet(code, context);
      }
      return code;
}
