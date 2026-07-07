use artistic_git_helpers::{
    askpass_prompt_from_args, invoke_helper_ipc, HelperInvocationEnv, HelperIpcEnvelope,
    HelperIpcResponse,
};
use std::{env, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("artistic-git-ssh-askpass: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let prompt = askpass_prompt_from_args(env::args().skip(1))?;
    let env = HelperInvocationEnv::from_process_env()?;
    let envelope = HelperIpcEnvelope::askpass(&env, prompt);

    match invoke_helper_ipc(&env, &envelope)? {
        HelperIpcResponse::Askpass { secret } => {
            println!("{secret}");
        }
        HelperIpcResponse::Error { message } => return Err(message.into()),
        HelperIpcResponse::Credential { .. } => {
            return Err("askpass helper received credential IPC response".into());
        }
        HelperIpcResponse::Empty => return Err("askpass helper received empty IPC response".into()),
    }

    Ok(())
}
