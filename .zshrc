eval "$(/opt/homebrew/bin/brew shellenv)"

autoload bashcompinit && bashcompinit
autoload -U +X compinit && compinit
source <(kubectl completion zsh)
complete -C '/opt/homebrew/bin/aws_completer' aws

alias k=kubectl
compdef __start_kubectl k

unsetopt BEEP
setopt hist_expire_dups_first
setopt inc_append_history
unsetopt share_history

export PATH=$PATH:~/.bin