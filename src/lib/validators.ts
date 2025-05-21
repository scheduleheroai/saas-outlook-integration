// src/lib/validators.ts

/**
 * Validates if a string looks like an E.164 phone number.
 * E.g., +15551234567
 * Basic check, allows leading '+' and digits.
 */
export const isValidE164 = (phoneNumber: string): boolean => {
    if (!phoneNumber) return false; // Allow empty if optional
    const e164Regex = /^\+[1-9]\d{1,14}$/; // Simple regex, adjust if needed
    return e164Regex.test(phoneNumber);
  };
  
  /**
   * Validates if a string is exactly 3 digits.
   */
   export const isValidAreaCode = (areaCode: string): boolean => {
       if (!areaCode) return false;
       const areaCodeRegex = /^\d{3}$/;
       return areaCodeRegex.test(areaCode);
   }