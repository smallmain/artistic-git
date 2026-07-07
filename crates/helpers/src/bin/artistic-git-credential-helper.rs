use artistic_git_helpers::{
    format_credential_response, invoke_helper_ipc, parse_credential_input,
    parse_credential_operation_from_args, HelperInvocationEnv, HelperIpcEnvelope,
    HelperIpcResponse,
};
use std::{env, io::Read, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("artistic-git-credential-helper: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let operation = parse_credential_operation_from_args(env::args().skip(1))?;

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let credential = parse_credential_input(operation, &input)?;

    let env = HelperInvocationEnv::from_process_env()?;
    let envelope = HelperIpcEnvelope::credential(&env, credential);

    match invoke_helper_ipc(&env, &envelope)? {
        HelperIpcResponse::Credential { credential } => {
            print!("{}", format_credential_response(&credential));
        }
        HelperIpcResponse::Empty => {}
        HelperIpcResponse::Error { message } => return Err(message.into()),
        HelperIpcResponse::Askpass { .. } => {
            return Err("credential helper received askpass IPC response".into());
        }
    }

    Ok(())
}
