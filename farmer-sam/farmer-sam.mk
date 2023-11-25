SHELL=bash
.DEFAULT_GOAL:=help

# Global Variables
AWS_ACCOUNT_ID := $(shell aws sts get-caller-identity --query "Account" --output text)
SAM_S3_BUCKET := aws-sam-deployments-$(AWS_ACCOUNT_ID)-${AWS_DEFAULT_REGION}
SAM_DIR := $(shell mkdir -p .sam && echo .sam)
SAM_PARAMS_CONFIG=.sam-params

## Use production params file
ifeq ($(ENV),production)
	SAM_PARAMS_CONFIG := .sam-params-prod
endif

##@ Farmer SAM Commands
deploy: APP_NAME ENV ## Deploy stack
	sam deploy \
		--template ${TEMPLATE} \
		--stack-name ${STACK_NAME} \
		--s3-bucket ${SAM_S3_BUCKET} \
		--s3-prefix ${APP_NAME}-${ENV} \
		--region ${AWS_DEFAULT_REGION} \
		--no-fail-on-empty-changeset \
		--capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND CAPABILITY_NAMED_IAM \
		--parameter-overrides ApplicationName=${APP_NAME} Environment=${ENV} ${PARAMS} \
		--tags \
			"sam:application"=${APP_NAME} \
			"sam:environment"=${ENV}

delete: APP_NAME ENV ## Delete stack
	@echo -n "${YELLOW}Are you sure you want to delete the stack ${STACK_NAME} in ${AWS_DEFAULT_REGION}? [y/N]${NC} " && read ans && [ $${ans:-N} = y ]
	aws cloudformation delete-stack --stack-name ${STACK_NAME}
ifneq (${BACKGROUND}, true) ## BACKGROUND=true to not wait for stack to delete
	aws cloudformation wait stack-delete-complete --stack-name ${STACK_NAME}
endif

sam_check_setup: ## Check Farmer SAM Setup
	@echo "INFO: Checking S3 deployment bucket..."
	@aws s3api head-bucket --bucket ${SAM_S3_BUCKET} || \
		( \
			echo "${RED}ERROR:${NC} Unable to find deployment S3 bucket ${SAM_S3_BUCKET}"; \
			echo "This means either Farmer SAM was not setup in this AWS account yet or no credentials exists in current session"; \
			exit 1 \
		)

# Required Variables
APP_NAME:
ifndef APP_NAME
	$(error APP_NAME config value is missing)
endif

ENV:
ifndef ENV
	$(error ENV parameter is missing)
endif

# Creates help menu with sections
# Usage:
# ##@ Section Name
# target-name: ## target description
help:
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

# Get single output value of a CFN stack
# Usage: $(call get_stack_output,${STACK_NAME},${OutputKey})
# - checks if json file exists before making CFN API call
# - then uses jq to parse single output variable
define get_stack_output
$(shell (
		test -f ${1}.json || \
		aws cloudformation describe-stacks --stack-name ${1} --output json > ${SAM_DIR}/${1}.json
	) && \
	cat ${SAM_DIR}/${1}.json | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "${2}") | .OutputValue'
)
endef
