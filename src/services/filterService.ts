export const extractFilter = (
    queryParams: Record<string, any> | null | undefined,
    validFields: string[]
): Record<string, any> => {
    if (!queryParams) return {};
    
    const list = validFields.reduce((acc, field) => {
        const value = queryParams[field];
        if (value) {
            // Handle range parameters (e.g., price[min], price[max], battery[min], battery[max])
            if (field.includes('[') && field.includes(']')) {
                const baseField = field.split('[')[0];
                const rangeType = field.split('[')[1].split(']')[0];
                
                if (!acc[baseField]) {
                    acc[baseField] = {};
                }
                acc[baseField][rangeType] = value;
            } else {
                // Handle comma-separated values by converting to array
                if (typeof value === 'string' && value.includes(',')) {
                    acc[field] = value.split(',').map(v => v.trim()).filter(v => v);
                } else {
                    acc[field] = value;
                }
            }
        }
        return acc;
    }, {} as Record<string, any>);
    return list;
};