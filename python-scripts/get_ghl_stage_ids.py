import requests
import json

# --- Configuration ---
# WARNING: Avoid hardcoding API keys in real applications!
API_KEY = "pit-2454799c-28c6-4d88-9840-2a26f49ea93b" # Your Agency API Key
LOCATION_ID = "GiVwSMecgxDvfZnkGiPK" # Your Location ID
TARGET_PIPELINE_ID = "HBC8q0U8XKRU3wDty6iy" # The specific pipeline ID you want stages for

BASE_URL = "https://services.leadconnectorhq.com"
ENDPOINT = "/opportunities/pipelines" # Endpoint to get all pipelines for the location
API_VERSION = "2021-07-28"

# --- Prepare Request ---
url = f"{BASE_URL}{ENDPOINT}"
headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Version": API_VERSION,
    "Accept": "application/json"
}
params = {
    "locationId": LOCATION_ID
}

# --- Make API Call ---
print(f"Fetching all pipelines for Location ID: {LOCATION_ID}...")
print(f"Looking for Pipeline ID: {TARGET_PIPELINE_ID}")

try:
    response = requests.get(url, headers=headers, params=params)

    # --- Process Response ---
    if response.status_code == 200:
        pipelines_data = response.json()
        print("Successfully fetched pipeline list.")

        found_pipeline = None
        # Ensure the 'pipelines' key exists and is a list before iterating
        if 'pipelines' in pipelines_data and isinstance(pipelines_data.get('pipelines'), list):
            # Iterate through the list of pipelines in the response
            for pipeline in pipelines_data['pipelines']:
                # Check if the current pipeline's ID matches the target ID
                if pipeline.get('id') == TARGET_PIPELINE_ID:
                    found_pipeline = pipeline
                    break # Exit the loop once the target pipeline is found
        else:
            print("Error: 'pipelines' key not found in response or is not a list.")
            # Potentially print pipelines_data here for debugging if needed
            # print(json.dumps(pipelines_data, indent=4))


        if found_pipeline:
            pipeline_name = found_pipeline.get('name', 'N/A')
            print(f"\nFound target pipeline: '{pipeline_name}' (ID: {TARGET_PIPELINE_ID})")

            # Extract the stages from the found pipeline object
            # GHL Stage data is usually a list of dictionaries (objects)
            pipeline_stages = found_pipeline.get('stages')

            if pipeline_stages is not None and isinstance(pipeline_stages, list):
                # Print the raw stage data for inspection - useful for debugging
                # print(f"\nRaw 'stages' data for this pipeline:\n{json.dumps(pipeline_stages, indent=2)}")

                stage_ids = []
                stage_details = [] # Store ID and Name pairs

                # Iterate through the stage objects in the list
                # Check structure: GHL sometimes returns [[]] for empty/default stages.
                if pipeline_stages and isinstance(pipeline_stages[0], dict):
                    for stage in pipeline_stages:
                        stage_id = stage.get('id')
                        stage_name = stage.get('name', 'Unknown Name') # Good to grab the name too
                        if stage_id: # Make sure stage_id is not None or empty
                            stage_ids.append(stage_id)
                            stage_details.append({"id": stage_id, "name": stage_name})

                if stage_details:
                    print("\n--- Stages Found ---")
                    for detail in stage_details:
                         print(f"  ID: {detail['id']:<25} Name: {detail['name']}") # Added formatting for alignment
                    print("--------------------")
                    # You can just use the list of IDs if needed:
                    # print("\nList of Stage IDs only:")
                    # print(stage_ids)
                else:
                    # Handle cases like empty stages list `[]` or `[[]]`
                    print("\nNo valid stage objects with IDs found within the 'stages' list for this pipeline.")
                    print(f"Raw 'stages' data was: {pipeline_stages}")


            else:
                print(f"\nError: 'stages' key not found within the pipeline object for ID '{TARGET_PIPELINE_ID}', or it's not a list.")
                print(f"Pipeline Object Data: {json.dumps(found_pipeline, indent=2)}")


        else:
            print(f"\nError: Pipeline with ID '{TARGET_PIPELINE_ID}' was not found in the list of pipelines for location '{LOCATION_ID}'.")
            print("Please double-check the Pipeline ID and Location ID.")

    # --- Add Error Handling for API call itself ---
    elif response.status_code == 401:
        print(f"\nError: Authentication failed (Status Code: {response.status_code}).")
        print("Check API Key (Bearer Token) and its permissions.")
        try: print(json.dumps(response.json(), indent=4))
        except: print(response.text)
    elif response.status_code == 400:
        print(f"\nError: Bad Request (Status Code: {response.status_code}).")
        print("Check if 'locationId' parameter is correct.")
        try: print(json.dumps(response.json(), indent=4))
        except: print(response.text)
    else:
        print(f"\nError: Failed to fetch pipelines. Status Code: {response.status_code}")
        try: print(json.dumps(response.json(), indent=4))
        except: print(response.text)

except requests.exceptions.RequestException as e:
    print(f"\nA network error occurred: {e}")
except Exception as e:
    print(f"\nAn unexpected error occurred: {e}")