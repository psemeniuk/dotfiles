eval "$(/opt/homebrew/bin/brew shellenv)"

autoload bashcompinit && bashcompinit
autoload -U +X compinit && compinit
source <(kubectl completion zsh)
complete -C '/opt/homebrew/bin/aws_completer' aws

compdef __start_kubectl k

unsetopt BEEP
setopt hist_expire_dups_first
setopt hist_ignore_all_dups
setopt inc_append_history
unsetopt share_history
export WORDCHARS=

export PATH=$PATH:~/.bin

##### ALIASES #####

export ALIAS_DEBUG=true #can stay for now until aliases becomes stable

function execute {
    if [[ $ALIAS_DEBUG = "true" ]]; then
        echo "DEBUG: $@"
    fi
    eval $@
}

#docker
function drun-fn {

    execute "docker run --rm -it -v $(PWD):/workdir --workdir=/workdir $@"
}
alias drun=drun-fn

function drunsh-fn {
    # TODO prefer bash
    execute "docker run --rm -it --entrypoint /bin/sh -v $(PWD):/workdir --workdir=/workdir $1"
}
alias drunsh=drunsh-fn

#builds most "local" and specific dockerfile. Tags by default by directory name
function dbuild-fn {
    dockerfile=$(find . -name 'Dockerfile*' -type f -print0 | xargs -0 ls | head -1)
    tag=$(echo "${PWD##*/}")
    if [[ $1 = "-t" ]]; then
        tag=$2
    fi

    echo "Building $dockerfile tagged '$tag'"
    execute "docker build -t $tag -f $dockerfile ."
}
alias dbuild=dbuild-fn

#kubernetes
alias k=kubectl
alias kgp=kubectl get pods
# TODO kubectl exec
# TODO kubectl logs
# TODO kubectl port forward

#misc
alias lower="tr '[:upper:]' '[:lower:]'"
alias upper="tr '[:lower:]' '[:upper:]'"
alias uuid="uuidgen | lower"
alias psa="ps aux"
alias lsa="exa -abghHliS"
alias myip='curl ipinfo.io/ip'
alias lanmyip='ipconfig getifaddr en0'
alias flushdns='sudo killall -HUP mDNSResponder'
alias untar='tar -zxvf '
alias genpass='echo "$(openssl rand -base64 5)-$(openssl rand -base64 5)-$(openssl rand -base64 5)"'
alias h='cd ~/'

function replace-fn {
    occurrences=$(sed "s/$1/$1\n/g" to_replace | grep -c $1)
    execute "sed -i '' 's/$1/$2/g' $3"
    echo "replaced $occurrences occurrences"
}
alias replace=replace-fn
