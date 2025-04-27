#!/bin/sh

# Check if this is resume mode or fresh start
if [ "$RESUME_MODE" = "true" ]; then
  echo "RESUME MODE: Continuing indexing with existing user and schema"
  
  # In resume mode, we expect the existing DB_USER, DB_NAME, DB_PASSWORD, DB_HOST, DB_SCHEMA, and DB_PORT to be set correctly
  if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_SCHEMA" ]; then
    echo "Error: Required environment variables for resume mode are not set."
    echo "Ensure DB_USER, DB_NAME, DB_PASSWORD, DB_HOST, DB_PORT, and DB_SCHEMA are set."
    exit 1
  fi
  
  echo "Using existing DB_USER: $DB_USER and DB_SCHEMA: $DB_SCHEMA"
  
  # Construct the DB_URL with the existing user
  export DB_URL=postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME
  
  # Log the schema being used
  echo "Using DB_SCHEMA: $DB_SCHEMA"
  
  # Start the squid services with the specified node options
  echo "Starting squid services in resume mode..."
  sqd run:marketplace --node-options=$NODE_OPTIONS
  
  exit 0
fi

# Regular mode - Generate a unique schema name and user credentials using a timestamp
CURRENT_TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
NEW_SCHEMA_NAME="marketplace_squid_${CURRENT_TIMESTAMP}"
NEW_DB_USER="marketplace_squid_user_${CURRENT_TIMESTAMP}"
SQUID_READER_USER="marketplace_squid_api_reader"
API_READER_USER="dapps_marketplace_user"
MARKETPLACE_TRADES_MV_ROLE="mv_trades_owner"
MARKETPLACE_SCHEMA="marketplace"

# Check if required environment variables are set
if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ]; then
  echo "Error: Required environment variables are not set."
  echo "Ensure DB_USER, DB_NAME, DB_PASSWORD, DB_HOST, and DB_PORT are set."
  exit 1
fi

# Log the generated variables
echo "Generated schema name: $NEW_SCHEMA_NAME"
echo "Generated user: $NEW_DB_USER"

# Set PGPASSWORD to handle password prompt
export PGPASSWORD=$DB_PASSWORD

# Fetch metadata and extract service name in one command
SERVICE_NAME=$(aws ecs describe-tasks \
  --cluster "$(curl -s $ECS_CONTAINER_METADATA_URI_V4/task | jq -r '.Cluster')" \
  --tasks "$(curl -s $ECS_CONTAINER_METADATA_URI_V4/task | jq -r '.TaskARN' | awk -F'/' '{print $NF}')" \
  --query 'tasks[0].group' --output text | sed 's|service:||')

echo "Service Name: $SERVICE_NAME"

# Connect to the database and create the new schema and user
psql -v ON_ERROR_STOP=1 --username "$DB_USER" --dbname "$DB_NAME" --host "$DB_HOST" --port "$DB_PORT" <<-EOSQL
  CREATE SCHEMA $NEW_SCHEMA_NAME;
  CREATE USER $NEW_DB_USER WITH PASSWORD '$DB_PASSWORD';
  GRANT ALL PRIVILEGES ON SCHEMA $NEW_SCHEMA_NAME TO $NEW_DB_USER;
  GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $NEW_DB_USER;
  ALTER USER $NEW_DB_USER SET search_path TO $NEW_SCHEMA_NAME;

  -- Grant schema usage to reader users
  GRANT USAGE ON SCHEMA $NEW_SCHEMA_NAME TO $API_READER_USER, $SQUID_READER_USER, $MARKETPLACE_TRADES_MV_ROLE;

  -- Make squid_server_user able to grant permissions on objects in this schema
  GRANT $NEW_DB_USER TO $DB_USER;

  -- Set default privileges for tables created by NEW_DB_USER
  ALTER DEFAULT PRIVILEGES FOR ROLE $NEW_DB_USER IN SCHEMA $NEW_SCHEMA_NAME
    GRANT SELECT ON TABLES TO $API_READER_USER, $SQUID_READER_USER, $MARKETPLACE_TRADES_MV_ROLE;

  -- Grant usage on marketplace schema
  GRANT USAGE ON SCHEMA $MARKETPLACE_SCHEMA TO $NEW_DB_USER;

  -- Add new user to mv_trades_owner
  GRANT $MARKETPLACE_TRADES_MV_ROLE TO $NEW_DB_USER;    

  -- Insert a new record into the indexers table
  INSERT INTO public.indexers (service, schema, db_user, created_at)
  VALUES ('$SERVICE_NAME', '$NEW_SCHEMA_NAME', '$NEW_DB_USER', NOW());
EOSQL

# Unset PGPASSWORD
unset PGPASSWORD

# Construct the DB_URL with the new user
export DB_URL=postgresql://$NEW_DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME
export DB_SCHEMA=$NEW_SCHEMA_NAME

# Log the constructed DB_URL
echo "Exported DB_SCHEMA: $DB_SCHEMA"

# Start the processor service and the GraphQL server, and write logs to a file
LOG_FILE="sqd_run_log_${CURRENT_TIMESTAMP}.txt"
echo "Starting squid services..."

# Start the squid services with the specified node options
sqd run:marketplace --node-options=$NODE_OPTIONS

